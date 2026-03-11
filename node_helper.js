const NodeHelper = require("node_helper");

module.exports = NodeHelper.create({
    async start() {
        this.config = null;
        this._timer = null;
        this._lastItems = [];
        this._pollInFlight = false;
        this._activeAbortController = null;
        this._fetchImpl = await this._resolveFetch();
    },

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        if (this._activeAbortController) {
            try {
                this._activeAbortController.abort();
            } catch (_) {}
        }
        this._activeAbortController = null;
    },

    socketNotificationReceived(notification, payload) {
        if (notification === "HRS_CONFIG") {
            this.config = this._sanitizeConfig(payload);

            if (!this.config.bridgeIp || !this.config.userId) {
                this.sendSocketNotification("HRS_ERROR", {
                    message: "HueRoomStatus: bridgeIp and userId are required."
                });
                return;
            }

            if (Array.isArray(this._lastItems) && this._lastItems.length) {
                this.sendSocketNotification("HRS_DATA", { items: this._lastItems });
            }

            this._startPolling();
            return;
        }

        if (notification === "HRS_TOGGLE" && payload) {
            this._setLightState(payload.id, { on: !!payload.on })
                .then(() => this._pollOnce(true))
                .catch((err) => {
                    this.sendSocketNotification("HRS_ERROR", {
                        message: `HueRoomStatus: Toggle failed (${err.message}).`
                    });
                });
            return;
        }

        if (notification === "HRS_COMMAND" && payload) {
            this._handleCommand(payload)
                .then(() => this._pollOnce(true))
                .catch((err) => {
                    this.sendSocketNotification("HRS_ERROR", {
                        message: `HueRoomStatus: Command failed (${err.message}).`
                    });
                });
        }
    },

    _sanitizeConfig(cfg) {
        const safe = { ...(cfg || {}) };

        safe.refreshMs = Number.isFinite(Number(safe.refreshMs))
            ? Math.max(5000, Number(safe.refreshMs))
            : 60000;

        safe.requestTimeoutMs = Number.isFinite(Number(safe.requestTimeoutMs))
            ? Math.max(1000, Number(safe.requestTimeoutMs))
            : 8000;

        safe.hideNameContains = Array.isArray(safe.hideNameContains)
            ? safe.hideNameContains.map(String)
            : [];

        safe.showOnlyOn = !!safe.showOnlyOn;
        safe.colour = safe.colour !== false;
        safe.mode = safe.mode === "groups" ? "groups" : "lights";
        safe.showUnreachable = safe.showUnreachable !== false;
        safe.touchToToggle = safe.touchToToggle !== false;

        return safe;
    },

    _startPolling() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;

        this._pollOnce(true).catch(() => {});

        this._timer = setInterval(() => {
            this._pollOnce(false).catch(() => {});
        }, this.config.refreshMs);
    },

    async _pollOnce(forceEmit) {
        if (!this.config || this._pollInFlight) return;

        this._pollInFlight = true;
        try {
            const { bridgeIp, userId, mode } = this.config;
            const url = `http://${bridgeIp}/api/${encodeURIComponent(userId)}/${mode}`;

            const json = await this._fetchJson(url);
            const items = mode === "groups"
                ? this._normalizeGroups(json)
                : this._normalizeLights(json);

            const filtered = this._applyFilters(items);
            const changed = JSON.stringify(filtered) !== JSON.stringify(this._lastItems);

            if (changed || forceEmit) {
                this._lastItems = filtered;
                this.sendSocketNotification("HRS_DATA", { items: filtered });
            }
        } catch (err) {
            this.sendSocketNotification("HRS_ERROR", {
                message: `HueRoomStatus: Failed to fetch from bridge (${err.message}).`
            });
        } finally {
            this._pollInFlight = false;
        }
    },

    _applyFilters(items) {
        const { showOnlyOn, hideNameContains, showUnreachable } = this.config;
        const needles = (hideNameContains || [])
            .map((s) => String(s).toLowerCase())
            .filter(Boolean);

        return items.filter((it) => {
            if (!showUnreachable && it.reachable === false) return false;
            if (showOnlyOn && !it.on) return false;
            if (needles.length) {
                const n = String(it.name || "").toLowerCase();
                if (needles.some((x) => n.includes(x))) return false;
            }
            return true;
        });
    },

    _normalizeLights(obj) {
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

        items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return items;
    },

    _normalizeGroups(obj) {
        const items = [];
        for (const id of Object.keys(obj || {})) {
            const group = obj[id] || {};
            const action = group.action || {};
            const state = group.state || {};
            const anyOn = typeof state.any_on === "boolean" ? state.any_on : !!action.on;
            const rgb = this.config.colour && anyOn ? this._deriveCssRgb(action) : null;

            items.push({
                id,
                type: "group",
                name: group.name || `Group ${id}`,
                on: anyOn,
                reachable: true,
                rgb
            });
        }

        items.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return items;
    },

    async _handleCommand(payload) {
        const action = String(payload.action || "").toLowerCase();
        const targets = this._resolveTargets(payload);

        if (this.config.mode !== "lights") {
            throw new Error("Voice light control currently expects mode: lights");
        }

        if (!targets.length) {
            throw new Error("No matching lights found");
        }

        if (action === "on" || action === "off") {
            for (const item of targets) {
                await this._setLightState(item.id, { on: action === "on" });
            }
            return;
        }

        if (action === "toggle") {
            for (const item of targets) {
                await this._setLightState(item.id, { on: !item.on });
            }
            return;
        }

        if (action === "color" && payload.rgb) {
            const xy = this._hexToXy(payload.rgb);
            for (const item of targets) {
                await this._setLightState(item.id, { on: true, xy });
            }
            return;
        }

        throw new Error("Unsupported Hue command");
    },

    _resolveTargets(payload) {
        const items = Array.isArray(this._lastItems) ? this._lastItems : [];
        const ids = Array.isArray(payload && payload.ids)
            ? payload.ids.map((x) => String(x))
            : [];
        const singleId = payload && payload.id != null ? String(payload.id) : "";
        const name = payload && payload.name ? String(payload.name).toLowerCase() : "";
        const nameContains = payload && payload.nameContains ? String(payload.nameContains).toLowerCase() : "";

        let targets = items;

        if (singleId) targets = targets.filter((x) => String(x.id) === singleId);
        if (ids.length) targets = targets.filter((x) => ids.includes(String(x.id)));
        if (name) targets = targets.filter((x) => String(x.name || "").toLowerCase() === name);
        if (nameContains) targets = targets.filter((x) => String(x.name || "").toLowerCase().includes(nameContains));

        return targets;
    },

    async _setLightState(id, state) {
        const { bridgeIp, userId } = this.config;
        const url = `http://${bridgeIp}/api/${encodeURIComponent(userId)}/lights/${encodeURIComponent(id)}/state`;

        const body = {};
        if (typeof state.on === "boolean") body.on = state.on;
        if (Array.isArray(state.xy)) body.xy = state.xy;

        await this._putJson(url, body);
    },

    async _resolveFetch() {
        if (typeof fetch === "function") {
            return fetch.bind(globalThis);
        }

        try {
            const mod = require("node-fetch");
            return (mod.default || mod);
        } catch (_) {
            throw new Error("No fetch implementation available");
        }
    },

    async _fetchJson(url) {
        const res = await this._fetchWithTimeout(url, {
            method: "GET"
        });

        if (!res.ok) {
            throw new Error(`Hue HTTP ${res.status} ${res.statusText}`);
        }

        const json = await res.json();
        this._throwHueApiErrors(json);
        return json;
    },

    async _putJson(url, body) {
        const res = await this._fetchWithTimeout(url, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {})
        });

        if (!res.ok) {
            throw new Error(`Hue HTTP ${res.status} ${res.statusText}`);
        }

        const json = await res.json().catch(() => null);
        this._throwHueApiErrors(json);
        return json;
    },

    async _fetchWithTimeout(url, options) {
        const timeoutMs = Number(this.config && this.config.requestTimeoutMs) || 8000;
        const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
        let timer = null;

        if (controller) {
            this._activeAbortController = controller;
            timer = setTimeout(() => {
                try {
                    controller.abort();
                } catch (_) {}
            }, timeoutMs);
        }

        try {
            const fetchOptions = controller
                ? { ...(options || {}), signal: controller.signal }
                : { ...(options || {}) };

            return await this._fetchImpl(url, fetchOptions);
        } catch (err) {
            if (err && (err.name === "AbortError" || /aborted/i.test(String(err.message || "")))) {
                throw new Error(`request timed out after ${timeoutMs}ms`);
            }
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
            if (this._activeAbortController === controller) {
                this._activeAbortController = null;
            }
        }
    },

    _throwHueApiErrors(json) {
        if (!Array.isArray(json)) return;

        const errors = json
            .filter((entry) => entry && entry.error)
            .map((entry) => entry.error.description || entry.error.type || "Unknown Hue API error");

        if (errors.length) {
            throw new Error(errors.join("; "));
        }
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
        const Y = Math.max(0, Math.min(1, bri / 254));
        const X = (Y / y) * x;
        const Z = (Y / y) * z;

        let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
        let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
        let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;

        r = Math.max(0, r);
        g = Math.max(0, g);
        b = Math.max(0, b);

        const max = Math.max(r, g, b);
        if (max > 1) {
            r /= max;
            g /= max;
            b /= max;
        }

        const gamma = (c) => (
            c <= 0.0031308
                ? 12.92 * c
                : (1.0 + 0.055) * Math.pow(c, 1.0 / 2.4) - 0.055
        );

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
        const h = (hue % 65535) / 65535;
        const s = Math.max(0, Math.min(1, sat / 254));
        const v = Math.max(0, Math.min(1, bri / 254));

        const i = Math.floor(h * 6);
        const f = h * 6 - i;
        const p = v * (1 - s);
        const q = v * (1 - f * s);
        const t = v * (1 - (1 - f) * s);

        let r;
        let g;
        let b;

        switch (i % 6) {
            case 0: r = v; g = t; b = p; break;
            case 1: r = q; g = v; b = p; break;
            case 2: r = p; g = v; b = t; break;
            case 3: r = p; g = q; b = v; break;
            case 4: r = t; g = p; b = v; break;
            default: r = v; g = p; b = q; break;
        }

        return {
            r: this._clamp8(r * 255),
            g: this._clamp8(g * 255),
            b: this._clamp8(b * 255)
        };
    },

    _ctBriToRgb(ct, bri) {
        const mired = Math.max(153, Math.min(500, ct));
        const kelvin = 1000000 / mired;

        const temp = kelvin / 100;
        let r;
        let g;
        let b;

        if (temp <= 66) r = 255;
        else r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);

        if (temp <= 66) g = 99.4708025861 * Math.log(temp) - 161.1195681661;
        else g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);

        if (temp >= 66) b = 255;
        else if (temp <= 19) b = 0;
        else b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;

        const v = Math.max(0, Math.min(1, bri / 254));
        return {
            r: this._clamp8(r * v),
            g: this._clamp8(g * v),
            b: this._clamp8(b * v)
        };
    },

    _hexToXy(hex) {
        const clean = String(hex || "").replace("#", "").padStart(6, "0");
        let r = parseInt(clean.slice(0, 2), 16) / 255;
        let g = parseInt(clean.slice(2, 4), 16) / 255;
        let b = parseInt(clean.slice(4, 6), 16) / 255;

        r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
        g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
        b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

        const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
        const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
        const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;

        const sum = X + Y + Z || 1;
        return [X / sum, Y / sum];
    }
});