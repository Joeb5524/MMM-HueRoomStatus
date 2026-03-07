const NodeHelper = require("node_helper");
const https = require("https");

module.exports = NodeHelper.create({
    start() {
        this.config = null;
        this.agent = new https.Agent({ rejectUnauthorized: false });
        this.timer = null;
        this.items = [];
    },

    socketNotificationReceived(notification, payload) {
        if (notification === "HUE_INIT") {
            this.config = payload || {};
            this._refresh().catch((e) => this._sendError(e));
            if (this.timer) clearInterval(this.timer);
            this.timer = setInterval(() => {
                this._refresh().catch((e) => this._sendError(e));
            }, Number(this.config.updateInterval || 30000));
        }

        if (notification === "HUE_TOGGLE" && payload) {
            this._setLightState(payload.id, { on: !!payload.on })
                .then(() => this._refresh())
                .catch((e) => this._sendError(e));
        }

        if (notification === "HUE_COMMAND" && payload) {
            this._handleVoice(payload).catch((e) => this._sendError(e));
        }
    },

    async _handleVoice(payload) {
        const action = String(payload.action || "").toLowerCase();

        if (action === "on" || action === "off") {
            for (const item of this.items) {
                await this._setLightState(item.id, { on: action === "on" });
            }
            await this._refresh();
            return;
        }

        if (action === "toggle") {
            for (const item of this.items) {
                await this._setLightState(item.id, { on: !item.on });
            }
            await this._refresh();
            return;
        }

        if (action === "color" && payload.rgb) {
            const xy = rgbToXy(payload.rgb);
            for (const item of this.items) {
                await this._setLightState(item.id, { on: true, xy });
            }
            await this._refresh();
        }
    },

    _requestJson({ method, path, body }) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;

            const req = https.request({
                host: this.config.bridgeIp,
                port: 443,
                method,
                path,
                agent: this.agent,
                timeout: 10000,
                headers: payload ? {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload)
                } : {}
            }, (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); }
                    } else {
                        reject(new Error(`Hue HTTP ${res.statusCode}`));
                    }
                });
            });

            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("Hue timeout")));

            if (payload) req.write(payload);
            req.end();
        });
    },

    async _refresh() {
        if (!this.config || !this.config.bridgeIp || !this.config.userId) return;

        const json = await this._requestJson({
            method: "GET",
            path: `/api/${encodeURIComponent(this.config.userId)}/lights`
        });

        this.items = Object.keys(json || {}).map((id) => {
            const light = json[id] || {};
            const state = light.state || {};
            return {
                id: String(id),
                name: light.name || `Light ${id}`,
                on: !!state.on,
                rgb: Array.isArray(state.xy) ? `rgb(255,255,255)` : null
            };
        });

        this.sendSocketNotification("HUE_STATE", { items: this.items });
    },

    async _setLightState(id, state) {
        const body = {};
        if (typeof state.on === "boolean") body.on = state.on;
        if (state.xy) body.xy = state.xy;

        await this._requestJson({
            method: "PUT",
            path: `/api/${encodeURIComponent(this.config.userId)}/lights/${encodeURIComponent(id)}/state`,
            body
        });
    },

    _sendError(e) {
        this.sendSocketNotification("HUE_ERROR", { message: e.message || "Hue error" });
    }
});

function rgbToXy(hex) {
    const clean = String(hex || "").replace("#", "");
    const num = parseInt(clean.padStart(6, "0"), 16);

    let r = ((num >> 16) & 255) / 255;
    let g = ((num >> 8) & 255) / 255;
    let b = (num & 255) / 255;

    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z || 1;

    return [X / sum, Y / sum];
}