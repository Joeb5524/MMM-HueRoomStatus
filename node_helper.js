const NodeHelper = require("node_helper");
const fetch = require("node-fetch");

module.exports = NodeHelper.create({
    start() {
        this.config = null;
        this._timer = null;
        this._lastItems = [];
    },

    socketNotificationReceived(notification, payload) {
        if (notification !== "HRS_CONFIG") return;

        this.config = this._sanitizeConfig(payload);

        if (!this.config.bridgeIp || !this.config.userId) {
            this.sendSocketNotification("HRS_ERROR", { message: "HueRoomStatus: bridgeIp and userId are required." });
            return;
        }

        if (Array.isArray(this._lastItems) && this._lastItems.length) {
            this.sendSocketNotification("HRS_DATA", { items: this._lastItems });
        }

        this._startPolling();
    },

    _sanitizeConfig(cfg) {
        const safe = { ...cfg };

        safe.refreshMs = Number.isFinite(Number(safe.refreshMs))
            ? Math.max(5_000, Number(safe.refreshMs))
            : 60_000;

        safe.hideNameContains = Array.isArray(safe.hideNameContains)
            ? safe.hideNameContains.map(String)
            : [];

        safe.showOnlyOn = !!safe.showOnlyOn;
        safe.colour = safe.colour !== false;
        safe.mode = safe.mode === "groups" ? "groups" : "lights";
        safe.showUnreachable = safe.showUnreachable !== false;

        return safe;
    },

    _startPolling() {
        if (this._timer) clearInterval(this._timer);

        // Immediately fetch once
        this._pollOnce().catch(() => {  });

        this._timer = setInterval(() => {
            this._pollOnce().catch(() => {  });
        }, this.config.refreshMs);
    },

    async _pollOnce() {
        const { bridgeIp, userId, mode } = this.config;
        const url = `http://${bridgeIp}/api/${encodeURIComponent(userId)}/${mode}`;

        let json;
        try {
            const res = await fetch(url, { method: "GET", timeout: 8000 });
            if (!res.ok) {
                throw new Error(`Hue HTTP ${res.status} ${res.statusText}`);
            }
            json = await res.json();
        } catch (err) {
            this.sendSocketNotification("HRS_ERROR", {
                message: `HueRoomStatus: Failed to fetch from bridge (${err.message}).`
            });
            return;
        }

        try {
            const items = mode === "groups"
                ? this._normalizeGroups(json)
                : this._normalizeLights(json);

            const filtered = this._applyFilters(items);

            // only push if changed
            const changed = JSON.stringify(filtered) !== JSON.stringify(this._lastItems);
            if (changed) {
                this._lastItems = filtered;
                this.sendSocketNotification("HRS_DATA", { items: filtered });
            } else {

            }
        } catch (err) {
            this.sendSocketNotification("HRS_ERROR", {
                message: `HueRoomStatus: Error parsing Hue payload (${err.message}).`
            });
        }
    },

    _applyFilters(items) {
        const { showOnlyOn, hideNameContains, showUnreachable } = this.config;
        const needles = (hideNameContains || [])
            .map(s => String(s).toLowerCase())
            .filter(Boolean);

        return items.filter(it => {
            if (!showUnreachable && it.reachable === false) return false;
            if (showOnlyOn && !it.on) return false;
            if (needles.length) {
                const n = String(it.name || "").toLowerCase();
                if (needles.some(x => n.includes(x))) return false;
            }
            return true;
        });
    },

    _normalizeLights(obj) {

        // light has: name, state: { on, reachable, bri, xy, hue, sat, ct, colormode }
        const items = [];
        for (const id of Object.keys(obj || {})) {
            const light = obj[id] || {};
            const state = light.state || {};

            const on = !!state.on;
            const reachable = state.reachable !== false;

            const rgb = this.config.colour && on && reachable
                ? this._deriveCssRgb(state)
                : null;

            items.push({
                id,
                type: "light",
                name: light.name || `Light ${id}`,
                on,
                reachable,
                rgb
            });
        }

        // Keep stable ordering by name
        items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return items;
    },

    _normalizeGroups(obj) {

        //  group has: name, state.any_on, state.all_on, lights[], etc.
        const items = [];
        for (const id of Object.keys(obj || {})) {
            const group = obj[id] || {};
            const state = group.state || {};
            const anyOn = !!state.any_on;


            items.push({
                id,
                type: "group",
                name: group.name || `Group ${id}`,
                on: anyOn,
                reachable: true,
                rgb: null
            });
        }

        items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return items;
    },

    _deriveCssRgb(state) {

        const bri = Number.isFinite(Number(state.bri)) ? Number(state.bri) : 254;

        if (Array.isArray(state.xy) && state.xy.length === 2) {
            const [x, y] = state.xy.map(Number);
            if (Number.isFinite(x) && Number.isFinite(y) && y > 0) {
                const { r, g, b } = this._xyBriToRgb(x, y, bri);
                return `rgb(${r},${g},${b})`;
            }
        }


        if (Number.isFinite(Number(state.hue)) && Number.isFinite(Number(state.sat))) {
            const hue = Number(state.hue);
            const sat = Number(state.sat);
            const { r, g, b } = this._hueSatBriToRgb(hue, sat, bri);
            return `rgb(${r},${g},${b})`;
        }


        if (Number.isFinite(Number(state.ct))) {
            const ct = Number(state.ct);
            const { r, g, b } = this._ctBriToRgb(ct, bri);
            return `rgb(${r},${g},${b})`;
        }

        return null;
    },

    _clamp8(n) {
        return Math.max(0, Math.min(255, Math.round(n)));
    },

    _xyBriToRgb(x, y, bri) {

        const z = 1.0 - x - y;
        const Y = Math.max(0, Math.min(1, bri / 254)); // luminance
        const X = (Y / y) * x;
        const Z = (Y / y) * z;


        let r =  X *  1.656492 - Y * 0.354851 - Z * 0.255038;
        let g = -X *  0.707196 + Y * 1.655397 + Z * 0.036152;
        let b =  X *  0.051713 - Y * 0.121364 + Z * 1.011530;


        r = Math.max(0, r);
        g = Math.max(0, g);
        b = Math.max(0, b);


        const max = Math.max(r, g, b);
        if (max > 1) {
            r /= max; g /= max; b /= max;
        }


        const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : (1.0 + 0.055) * Math.pow(c, 1.0 / 2.4) - 0.055);

        r = gamma(r);
        g = gamma(g);
        b = gamma(b);

        return {
            r: this._clamp8(r * 255),
            g: this._clamp8(g * 255),
            b: this._clamp8(b * 255)
        };
    },

    _hueSatBriToRgb(hue, sat, bri) {

        const h = (hue % 65535) / 65535;   // 0..1
        const s = Math.max(0, Math.min(1, sat / 254));
        const v = Math.max(0, Math.min(1, bri / 254));


        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);

        let r, g, b;
        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            case 5: r = v; g = p; b = q; break;
        }

        return {
            r: this._clamp8(r * 255),
            g: this._clamp8(g * 255),
            b: this._clamp8(b * 255)
        };
    },

    _ctBriToRgb(ct, bri) {

        const mired = Math.max(153, Math.min(500, ct));
        const kelvin = 1_000_000 / mired;


        let temp = kelvin / 100;

        let r, g, b;

        // r
        if (temp <= 66) r = 255;
        else r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);

        // g
        if (temp <= 66) g = 99.4708025861 * Math.log(temp) - 161.1195681661;
        else g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);

        // b
        if (temp >= 66) b = 255;
        else if (temp <= 19) b = 0;
        else b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;

        // apply brightness (v)
        const v = Math.max(0, Math.min(1, bri / 254));
        return {
            r: this._clamp8(r * v),
            g: this._clamp8(g * v),
            b: this._clamp8(b * v)
        };
    }
});