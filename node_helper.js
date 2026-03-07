const NodeHelper = require("node_helper");
const fetch = require("node-fetch");
const https = require("https");

module.exports = NodeHelper.create({
    start() {
        this.config = null;
        this._timer = null;

        this._lastItems = [];
        this._lastAllItems = [];

        this._httpsAgent = new https.Agent({ rejectUnauthorized: false });
        this._rateLimiter = new RateLimiter({ minIntervalMs: 120 });
    },

    socketNotificationReceived(notification, payload) {
        if (notification === "HRS_CONFIG") {
            this.config = this._sanitizeConfig(payload);

            if (!this.config.bridgeIp) {
                this.sendSocketNotification("HRS_ERROR", { message: "HueRoomStatus: bridgeIp required" });
                return;
            }

            const api = this._determineApi();
            if (api === "v2" && !this.config.hueApplicationKey) {
                this.sendSocketNotification("HRS_ERROR", { message: "HueRoomStatus: hueApplicationKey required for v2" });
                return;
            }
            if (api === "v1" && !this.config.userId) {
                this.sendSocketNotification("HRS_ERROR", { message: "HueRoomStatus: userId required for v1" });
                return;
            }

            this._httpsAgent = new https.Agent({ rejectUnauthorized: !this.config.insecureSkipVerify });

            this._startPolling();
            return;
        }

        if (notification === "HRS_SET_STATE") {
            this._handleSetState(payload)
                .catch(err => this.sendSocketNotification("HRS_CMD_ERROR", { id: payload && payload.id, message: err.message }));
            return;
        }

        if (notification === "HRS_HUE_COMMAND") {
            this._handleHueCommand(payload)
                .catch(err => this.sendSocketNotification("HRS_CMD_ERROR", { message: err.message }));
        }
    },

    _sanitizeConfig(cfg) {
        const safe = { ...cfg };
        safe.refreshMs = Number.isFinite(Number(safe.refreshMs)) ? Math.max(5000, Number(safe.refreshMs)) : 60000;
        safe.hideNameContains = Array.isArray(safe.hideNameContains) ? safe.hideNameContains.map(String).filter(Boolean) : [];
        safe.mode = safe.mode === "groups" ? "groups" : "lights";
        safe.apiVersion = safe.apiVersion || "auto";
        safe.bridgeIp = safe.bridgeIp ? String(safe.bridgeIp) : "";
        safe.hueApplicationKey = safe.hueApplicationKey ? String(safe.hueApplicationKey) : "";
        safe.userId = safe.userId ? String(safe.userId) : "";
        safe.insecureSkipVerify = safe.insecureSkipVerify !== false;
        safe.colour = safe.colour !== false;
        return safe;
    },

    _determineApi() {
        const v = String(this.config.apiVersion || "auto").toLowerCase();
        if (v === "v2" || v === "2") return "v2";
        if (v === "v1" || v === "1") return "v1";
        return this.config.hueApplicationKey ? "v2" : "v1";
    },

    _startPolling() {
        if (this._timer) clearInterval(this._timer);

        this._pollOnce().catch(() => {});
        this._timer = setInterval(() => this._pollOnce().catch(() => {}), this.config.refreshMs);
    },

    async _pollOnce() {
        if (!this.config) return;

        const api = this._determineApi();
        const allItems = api === "v2" ? await this._pollOnceV2() : await this._pollOnceV1();
        this._lastAllItems = allItems;

        const items = this._applyFilters(allItems);
        this._lastItems = items;

        this.sendSocketNotification("HRS_DATA", { items });
    },

    _applyFilters(items) {
        const needles = this.config.hideNameContains.map(s => String(s).toLowerCase());
        return (items || []).filter(it => {
            const n = String(it.name || "").toLowerCase();
            if (needles.some(x => n.includes(x))) return false;
            return true;
        }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },

    async _pollOnceV1() {
        const url = `https://${this.config.bridgeIp}/api/${encodeURIComponent(this.config.userId)}/${this.config.mode}`;
        const res = await fetch(url, { method: "GET", timeout: 10000, agent: this._httpsAgent });
        if (!res.ok) throw new Error(`Hue v1 GET failed ${res.status}`);
        const json = await res.json();

        return (this.config.mode === "groups") ? normalizeV1Groups(json) : normalizeV1Lights(json, this.config.colour);
    },

    async _pollOnceV2() {
        const headers = { "hue-application-key": this.config.hueApplicationKey, "Accept": "application/json" };
        const base = `https://${this.config.bridgeIp}`;

        if (this.config.mode === "groups") {
            const grouped = await v2Get(`${base}/clip/v2/resource/grouped_light`, headers, this._httpsAgent);
            const rooms = await v2Get(`${base}/clip/v2/resource/room`, headers, this._httpsAgent).catch(() => ({ data: [] }));
            const roomNameById = new Map((rooms.data || []).map(r => [String(r.id), String(r?.metadata?.name || r.id)]));
            return normalizeV2Grouped(grouped.data || [], roomNameById, this.config.colour);
        }

        const lights = await v2Get(`${base}/clip/v2/resource/light`, headers, this._httpsAgent);
        return normalizeV2Lights(lights.data || [], this.config.colour);
    },

    async _handleSetState(payload) {
        const id = payload && payload.id ? String(payload.id) : null;
        const type = payload && payload.type ? String(payload.type) : (this.config.mode === "groups" ? "group" : "light");
        const on = payload && typeof payload.on === "boolean" ? payload.on : null;
        if (!id || typeof on !== "boolean") throw new Error("Invalid toggle payload");

        const api = this._determineApi();

        await this._rateLimiter.enqueue(async () => {
            if (api === "v2") return this._v2SetState({ id, type, on });
            return this._v1SetState({ id, type, on });
        });

        this.sendSocketNotification("HRS_CMD_OK", { id });
        setTimeout(() => this._pollOnce().catch(() => {}), 450);
    },

    async _handleHueCommand(cmd) {
        const action = String(cmd && (cmd.action || cmd.intent || cmd.command) || "").toLowerCase();
        const rgb = cmd && (cmd.rgb || cmd.color || cmd.colour) ? String(cmd.rgb || cmd.color || cmd.colour) : null;
        const targetName = String(cmd && (cmd.target || cmd.room || cmd.group || cmd.targetName) || "");
        const targetId = cmd && (cmd.id || cmd.targetId) ? String(cmd.id || cmd.targetId) : null;

        const items = Array.isArray(this._lastAllItems) ? this._lastAllItems : [];
        if (!items.length) throw new Error("No Hue cache yet");

        const targets = resolveTargets(items, { targetId, targetName });
        if (!targets.length) throw new Error("No matching Hue items");

        const api = this._determineApi();

        for (const t of targets) {
            const id = String(t.id);
            const type = String(t.type || "light");

            let on;
            if (action === "on" || action === "turn_on") on = true;
            else if (action === "off" || action === "turn_off") on = false;
            else if (action === "toggle") on = !t.on;

            await this._rateLimiter.enqueue(async () => {
                if (api === "v2") return this._v2SetState({ id, type, on, rgb: (action === "color" || action === "rgb") ? rgb : null });
                return this._v1SetState({ id, type, on, rgb: (action === "color" || action === "rgb") ? rgb : null });
            });

            this.sendSocketNotification("HRS_CMD_OK", { id });
        }

        setTimeout(() => this._pollOnce().catch(() => {}), 650);
    },

    async _v1SetState({ id, type, on, rgb }) {
        const isGroup = String(type) === "group" || this.config.mode === "groups";
        const path = isGroup
            ? `/api/${encodeURIComponent(this.config.userId)}/groups/${encodeURIComponent(id)}/action`
            : `/api/${encodeURIComponent(this.config.userId)}/lights/${encodeURIComponent(id)}/state`;

        const url = `https://${this.config.bridgeIp}${path}`;
        const body = {};
        if (typeof on === "boolean") body.on = on;

        if (rgb) {
            const { r, g, b } = parseCssOrHexRgb(rgb);
            const xy = rgbToXy(r, g, b);
            body.xy = [xy.x, xy.y];
            if (typeof on !== "boolean") body.on = true;
        }

        const res = await fetch(url, {
            method: "PUT",
            timeout: 10000,
            agent: this._httpsAgent,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`Hue v1 PUT failed ${res.status}`);
    },

    async _v2SetState({ id, type, on, rgb }) {
        const isGroup = String(type) === "group";
        const rtype = isGroup ? "grouped_light" : "light";

        const url = `https://${this.config.bridgeIp}/clip/v2/resource/${rtype}/${encodeURIComponent(id)}`;
        const headers = { "hue-application-key": this.config.hueApplicationKey, "Accept": "application/json", "Content-Type": "application/json" };

        const body = {};
        if (typeof on === "boolean") body.on = { on };
        if (rgb) {
            const { r, g, b } = parseCssOrHexRgb(rgb);
            const xy = rgbToXy(r, g, b);
            body.color = { xy: { x: xy.x, y: xy.y } };
            if (typeof on !== "boolean") body.on = { on: true };
        }

        const res = await fetch(url, { method: "PUT", timeout: 10000, agent: this._httpsAgent, headers, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`Hue v2 PUT failed ${res.status}`);
    }
});

async function v2Get(url, headers, agent) {
    const res = await fetch(url, { method: "GET", timeout: 10000, agent, headers });
    if (!res.ok) throw new Error(`Hue v2 GET failed ${res.status}`);
    return res.json();
}

function resolveTargets(items, { targetId, targetName }) {
    if (targetId) {
        const t = items.find(x => String(x.id) === String(targetId));
        return t ? [t] : [];
    }
    const name = String(targetName || "").trim().toLowerCase();
    if (!name || name === "all") return items;
    return items.filter(x => String(x.name || "").toLowerCase().includes(name));
}

class RateLimiter {
    constructor({ minIntervalMs }) {
        this.min = Math.max(0, Number(minIntervalMs) || 0);
        this._p = Promise.resolve();
        this._last = 0;
    }
    enqueue(fn) {
        this._p = this._p.then(async () => {
            const now = Date.now();
            const wait = Math.max(0, this.min - (now - this._last));
            if (wait) await new Promise(r => setTimeout(r, wait));
            const out = await fn();
            this._last = Date.now();
            return out;
        });
        return this._p;
    }
}

function normalizeV1Lights(obj, colour) {
    const items = [];
    for (const id of Object.keys(obj || {})) {
        const light = obj[id] || {};
        const state = light.state || {};
        const on = !!state.on;
        const reachable = state.reachable !== false;
        const rgb = (colour && on && reachable) ? deriveCssRgbFromV1State(state) : null;
        items.push({ id: String(id), type: "light", name: light.name || `Light ${id}`, on, reachable, rgb });
    }
    return items;
}

function normalizeV1Groups(obj) {
    const items = [];
    for (const id of Object.keys(obj || {})) {
        const g = obj[id] || {};
        const anyOn = !!(g.state && g.state.any_on);
        items.push({ id: String(id), type: "group", name: g.name || `Group ${id}`, on: anyOn, reachable: true, rgb: null });
    }
    return items;
}

function normalizeV2Lights(list, colour) {
    const items = [];
    for (const l of (list || [])) {
        const id = String(l.id);
        const name = l?.metadata?.name ? String(l.metadata.name) : `Light ${id}`;
        const on = !!l?.on?.on;
        const xy = (Number.isFinite(Number(l?.color?.xy?.x)) && Number.isFinite(Number(l?.color?.xy?.y)))
            ? { x: Number(l.color.xy.x), y: Number(l.color.xy.y) } : null;
        const briPct = Number.isFinite(Number(l?.dimming?.brightness)) ? Number(l.dimming.brightness) : 100;
        const bri254 = Math.max(1, Math.min(254, Math.round(briPct * 254 / 100)));
        const rgb = (colour && on) ? deriveCssRgbFromXy({ xy, bri: bri254 }) : null;

        items.push({ id, type: "light", name, on, reachable: true, rgb });
    }
    return items;
}

function normalizeV2Grouped(list, roomNameById, colour) {
    const items = [];
    for (const g of (list || [])) {
        const id = String(g.id);
        const ownerRid = g?.owner?.rid ? String(g.owner.rid) : null;
        const name = ownerRid ? (roomNameById.get(ownerRid) || `Group ${id}`) : `Group ${id}`;
        const on = !!g?.on?.on;

        const xy = (Number.isFinite(Number(g?.color?.xy?.x)) && Number.isFinite(Number(g?.color?.xy?.y)))
            ? { x: Number(g.color.xy.x), y: Number(g.color.xy.y) } : null;
        const briPct = Number.isFinite(Number(g?.dimming?.brightness)) ? Number(g.dimming.brightness) : 100;
        const bri254 = Math.max(1, Math.min(254, Math.round(briPct * 254 / 100)));
        const rgb = (colour && on) ? deriveCssRgbFromXy({ xy, bri: bri254 }) : null;

        items.push({ id, type: "group", name, on, reachable: true, rgb });
    }
    return items;
}

function parseCssOrHexRgb(input) {
    const s = String(input || "").trim().toLowerCase();
    const hex = s.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    const rgb = s.match(/^rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)$/);
    if (rgb) return { r: clamp8(rgb[1]), g: clamp8(rgb[2]), b: clamp8(rgb[3]) };
    return { r: 255, g: 255, b: 255 };
}
function clamp8(n) { return Math.max(0, Math.min(255, Math.round(Number(n) || 0))); }

function rgbToXy(r8, g8, b8) {
    let r = r8 / 255, g = g8 / 255, b = b8 / 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z || 1;
    return { x: X / sum, y: Y / sum };
}

function xyBriToRgb(x, y, bri) {
    const Y = Math.max(0, Math.min(1, bri / 254));
    const X = (Y / y) * x;
    const Z = (Y / y) * (1 - x - y);

    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;

    r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(r, 1 / 2.4) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(g, 1 / 2.4) - 0.055;
    b = b <= 0.0031308 ? 12.92 * b : 1.055 * Math.pow(b, 1 / 2.4) - 0.055;

    r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
    const max = Math.max(r, g, b);
    if (max > 1) { r /= max; g /= max; b /= max; }

    return { r: clamp8(r * 255), g: clamp8(g * 255), b: clamp8(b * 255) };
}

function deriveCssRgbFromXy({ xy, bri }) {
    if (!xy || !Number.isFinite(xy.x) || !Number.isFinite(xy.y) || xy.y <= 0) return null;
    const { r, g, b } = xyBriToRgb(Number(xy.x), Number(xy.y), Number(bri) || 254);
    return `rgb(${r},${g},${b})`;
}

function deriveCssRgbFromV1State(state) {
    if (Array.isArray(state.xy) && state.xy.length === 2) {
        const { r, g, b } = xyBriToRgb(Number(state.xy[0]), Number(state.xy[1]), Number(state.bri) || 254);
        return `rgb(${r},${g},${b})`;
    }
    return null;
}
