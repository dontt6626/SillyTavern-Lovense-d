/**
 * Minimal Buttplug WebSocket Client for SillyTavern Lovense Extension
 *
 * Implements the Buttplug Protocol v3 over WebSocket.
 * Connects to Intiface Central (or any buttplug server) on ws://localhost:12345
 *
 * No external dependencies — pure browser WebSocket + JSON.
 */

let messageId = 1;
function nextId() { return messageId++; }

export class ButtplugClient {
    constructor(clientName = 'SillyTavern-Lovense') {
        this.clientName = clientName;
        this.ws = null;
        this.connected = false;
        this.devices = new Map(); // DeviceIndex -> { name, index, messageTypes }
        this.pending = new Map(); // id -> { resolve, reject, timer }
        this.onDeviceAdded = null;
        this.onDeviceRemoved = null;
        this.onError = null;
    }

    async connect(url = 'ws://localhost:12345') {
        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(url);

                this.ws.onopen = async () => {
                    try {
                        await this._send({ RequestServerInfo: { Id: nextId(), ClientName: this.clientName, MessageVersion: 3 } });
                        const devices = await this._send({ RequestDeviceList: { Id: nextId() } });
                        this._handleDeviceList(devices);
                        this.connected = true;
                        resolve(true);
                    } catch (e) {
                        reject(e);
                    }
                };

                this.ws.onmessage = (event) => {
                    try {
                        const msgs = JSON.parse(event.data);
                        for (const msg of (Array.isArray(msgs) ? msgs : [msgs])) {
                            this._handleMessage(msg);
                        }
                    } catch (e) {
                        console.error('[Buttplug] Parse error:', e);
                    }
                };

                this.ws.onclose = () => {
                    this.connected = false;
                    this.devices.clear();
                };

                this.ws.onerror = (e) => {
                    reject(new Error('WebSocket error: ' + (e.message || 'connection failed')));
                };
            } catch (e) {
                reject(e);
            }
        });
    }

    disconnect() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) { /* ignore */ }
            this.ws = null;
        }
        this.connected = false;
        this.devices.clear();
        // Clear pending promises
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('Disconnected'));
        }
        this.pending.clear();
    }

    async startScanning() {
        if (!this.connected) throw new Error('Not connected');
        await this._send({ StartScanning: { Id: nextId() } });
    }

    async stopScanning() {
        if (!this.connected) throw new Error('Not connected');
        await this._send({ StopScanning: { Id: nextId() } });
    }

    async vibrate(deviceIndex, speed) {
        // speed: 0.0 - 1.0
        if (!this.connected) throw new Error('Not connected');
        const clamped = Math.max(0, Math.min(1, speed));
        await this._send({ VibrateCmd: { Id: nextId(), DeviceIndex: deviceIndex, Speeds: [{ Index: 0, Speed: clamped }] } });
    }

    async rotate(deviceIndex, speed, clockwise = true) {
        if (!this.connected) throw new Error('Not connected');
        const clamped = Math.max(0, Math.min(1, speed));
        await this._send({ RotateCmd: { Id: nextId(), DeviceIndex: deviceIndex, Speeds: [{ Index: 0, Speed: clamped, Clockwise: clockwise }] } });
    }

    async linear(deviceIndex, position, durationMs = 1000) {
        if (!this.connected) throw new Error('Not connected');
        const clamped = Math.max(0, Math.min(1, position));
        await this._send({ LinearCmd: { Id: nextId(), DeviceIndex: deviceIndex, Vectors: [{ Index: 0, Duration: Math.max(100, durationMs), Position: clamped }] } });
    }

    async stopDevice(deviceIndex) {
        if (!this.connected) throw new Error('Not connected');
        await this._send({ StopDeviceCmd: { Id: nextId(), DeviceIndex: deviceIndex } });
    }

    async stopAll() {
        if (!this.connected) throw new Error('Not connected');
        await this._send({ StopAllDevices: { Id: nextId() } });
    }

    _handleMessage(msg) {
        // Check for response to a pending request
        const id = msg?.[Object.keys(msg)[0]]?.Id;
        if (id && this.pending.has(id)) {
            const { resolve, reject, timer } = this.pending.get(id);
            clearTimeout(timer);
            this.pending.delete(id);

            if (msg.Error) {
                reject(new Error(msg.Error.ErrorMessage || 'Buttplug error'));
            } else {
                resolve(msg);
            }
            return;
        }

        // Handle server-initiated messages
        if (msg.DeviceAdded) {
            const d = msg.DeviceAdded;
            this.devices.set(d.DeviceIndex, { name: d.DeviceName, index: d.DeviceIndex, messageTypes: d.DeviceMessages || {} });
            if (this.onDeviceAdded) this.onDeviceAdded(this.devices.get(d.DeviceIndex));
        }
        if (msg.DeviceRemoved) {
            const d = msg.DeviceRemoved;
            const device = this.devices.get(d.DeviceIndex);
            this.devices.delete(d.DeviceIndex);
            if (this.onDeviceRemoved && device) this.onDeviceRemoved(device);
        }
        if (msg.ScanningFinished) {
            console.log('[Buttplug] Scanning finished');
        }
        if (msg.Error) {
            console.error('[Buttplug] Server error:', msg.Error);
            if (this.onError) this.onError(msg.Error);
        }
    }

    _handleDeviceList(response) {
        if (response.DeviceList && response.DeviceList.Devices) {
            for (const d of response.DeviceList.Devices) {
                this.devices.set(d.DeviceIndex, { name: d.DeviceName, index: d.DeviceIndex, messageTypes: d.DeviceMessages || {} });
            }
        }
    }

    _send(msgObj) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not open'));
                return;
            }

            const id = msgObj[Object.keys(msgObj)[0]].Id;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('Buttplug request timed out'));
            }, 5000);

            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify([msgObj]));
        });
    }
}
