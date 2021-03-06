const SerialPort = require('serialport');
const Session = require('./session');
const Arduino = require('../upload/arduino');
const ansi = require('ansi-string');

const getUUID = id => {
    if (typeof id === 'number') return id.toString(16);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        return id.split('-').join('');
    }
    return id;
};

class SerialportSession extends Session {
    constructor(socket) {
        super(socket);
        this._type = 'serialport';
        this.peripheral = null;
        this.peripheralParams = null;
        this.services = null;
        this.reportedPeripherals = {};
        this.connectStateDetectorTimer = null;
        this.peripheralsScanorTimer = null;
        this.isRead = false;
    }

    async didReceiveCall(method, params, completion) {
        switch (method) {
            case 'discover':
                this.discover(params);
                completion(null, null);
                break;
            case 'connect':
                await this.connect(params);
                completion(null, null);
                break;
            case 'disconnect':
                await this.disconnect(params);
                completion(null, null);
                break;
            case 'write':
                completion(await this.write(params), null);
                break;
            case 'read':
                await this.read(params);
                completion(null, null);
                break;
            case 'upload':
                completion(await this.upload(params), null);
                break;
            case 'getServices':
                completion((this.services || []).map(service => service.uuid), null);
                break;
            case 'pingMe':
                completion('willPing', null);
                this.sendRemoteRequest('ping', null, (result, error) => {
                    console.log(`Got result from ping: ${result}`);
                });
                break;
            default:
                throw new Error(`Method not found`);
        }
    }

    discover(params) {
        if (this.services) {
            throw new Error('cannot discover when connected');
        }
        const { filters } = params;
        if (!Array.isArray(filters.pnpid) || filters.pnpid.length < 1) {
            throw new Error('discovery request must include filters');
        }
        this.reportedPeripherals = {};

        this.peripheralsScanorTimer = setInterval(function () {
            SerialPort.list().then(peripheral => {
                this.onAdvertisementReceived(peripheral, filters);
            })
        }.bind(this), 100);
    }

    onAdvertisementReceived(peripheral, filters) {
        if (peripheral != null) {
            peripheral.forEach((device) => {
                let pnpid = device.pnpId.substring(0, 21);
                let name;

                if (pnpid == 'USB\\VID_1A86&PID_7523') {
                    name = 'USB-SERIAL CH340'
                }
                else {
                    name = 'Unknown device'
                }

                if (filters.pnpid.includes('*')) {
                    this.reportedPeripherals[device.path] = device;
                    this.sendRemoteRequest('didDiscoverPeripheral', {
                        peripheralId: device.path,
                        name: name + ' (' + device.path + ')',
                    });
                }
                else {
                    if (filters.pnpid.includes(pnpid)) {

                        this.reportedPeripherals[device.path] = device;
                        this.sendRemoteRequest('didDiscoverPeripheral', {
                            peripheralId: device.path,
                            name: name + ' (' + device.path + ')',
                        });
                    }
                }
            })
        }
    }

    connect(params, afterupload=null) {
        return new Promise((resolve, reject) => {
            if (this.peripheral && this.peripheral.isOpen == true) {
                return reject(new Error('already connected to peripheral'));
            }
            const { peripheralId } = params;
            const { peripheralConfig } = params;
            const peripheral = this.reportedPeripherals[peripheralId];
            if (!peripheral) {
                return reject(new Error(`invalid peripheral ID: ${peripheralId}`));
            }
            if (this.peripheralsScanorTimer) {
                clearInterval(this.peripheralsScanorTimer);
                this.peripheralsScanorTimer == null;
            }
            const port = new SerialPort(peripheral.path, {
                baudRate: peripheralConfig.config.baudRate,
                dataBits: peripheralConfig.config.dataBits,
                stopBits: peripheralConfig.config.stopBits,
                autoOpen: false
            });
            try {
                port.open(error => {
                    if (error) {
                        if (afterupload == true) {
                            this.sendRemoteRequest('peripheralUnplug', {});
                        }
                        return reject(new Error(error));
                    }

                    this.peripheral = port;
                    this.peripheralParams = params;

                    // Scan COM status prevent device pulled out
                    this.connectStateDetectorTimer = setInterval(function () {
                        if (this.peripheral.isOpen == false) {
                            clearInterval(this.connectStateDetectorTimer);
                            console.log('pulled out disconnect');
                            this.disconnect();
                            this.sendRemoteRequest('peripheralUnplug', {});
                        }
                    }.bind(this), 10);

                    // Only when the receiver function is set, can isopen detect that the device is pulled out
                    // A strange features of npm serialport package
                    port.on('data', function (rev) {
                        this.onMessageCallback(rev);
                    }.bind(this));

                    resolve();
                });
            } catch (err) {
                reject(err);
            }
        })
    }

    onMessageCallback(rev) {
        const params = {
            encoding: 'base64',
            message: rev.toString('base64')
        };
        if (this.isRead) {
            this.sendRemoteRequest('onMessage', params);
        }
    }

    async write(params) {
        const { message, encoding } = params;
        const buffer = new Buffer(message, encoding);

        this.peripheral.write(buffer, 'Buffer', (err) => {
            if (err) {
                return new Error(`Error while attempting to write: ${err.message}`);
            } else {
                return buffer.length;
            }
        })
    }

    read() {
        this.isRead = true;
    }

    disconnect() {
        if (this.peripheral && this.peripheral.isOpen == true) {
            if (this.connectStateDetectorTimer) {
                clearInterval(this.connectStateDetectorTimer);
                this.connectStateDetectorTimer = null;
            }
            this.peripheral.close(error => {
                if (error) {
                    return reject(new Error(error));
                }
            });
        }
    }
    async upload(params) {
        const { message, config, encoding } = params;
        const code = new Buffer.from(message, encoding).toString();
        
        switch (config.type) {
            case 'arduino':
                const arduino = new Arduino;

                try {
                    const exitCode = await arduino.build(code, config.board, this.sendstd.bind(this));
                    if (exitCode == 'Success') {
                        this.disconnect();
                        await arduino.flash(this.peripheral.path, config.partno, this.sendstd.bind(this));
                        await this.connect(this.peripheralParams, true);
                        this.sendRemoteRequest('uploadSuccess', {});
                    }
                } catch (err) {
                    this.sendRemoteRequest('uploadError', {
                        message: ansi.red + err.message
                    });
                }
                break;
            case 'microbit':
                // todo: for Microbit
                break;
        }
    }

    sendstd(message) { 
        this.sendRemoteRequest('uploadStdout', {
            message: message
        });
    }

    dispose() {
        this.disconnect();
        super.dispose();
        this.socket = null;
        this.peripheral = null;
        this.peripheralParams = null;
        this.services = null;
        this.reportedPeripherals = null;
        if (this.connectStateDetectorTimer) {
            clearInterval(this.connectStateDetectorTimer);
            this.connectStateDetectorTimer = null;
        }
        if (this.peripheralsScanorTimer) {
            clearInterval(this.peripheralsScanorTimer);
            this.peripheralsScanorTimer == null;
        }
        this.isRead = false;
    }
}

module.exports = SerialportSession;