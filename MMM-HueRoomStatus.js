/* global Module */

/**
 * Displays Hue light/group status and supports:
 *  - tap-to-toggle rows
 *  - voice control via MagicMirror notification "HUE_COMMAND"
 */
Module.register("MMM-HueRoomStatus", {
    defaults: {
        header: "Hue Lights",
        bridgeIp: "",
        apiVersion: "auto", // auto | v2 | v1
        hueApplicationKey: "", // v2
        userId: "", // v1
        mode: "lights", // lights | groups

        refreshMs: 60 * 1000,
        animationSpeed: 1000,

        showOnlyOn: false,
        showLabel: true,
        hideNameContains: [],

        colour: true,
        showUnreachable: true,
        maxItems: 12,

        touchToggle: true,
        toggleDebounceMs: 350,
        optimisticUi: true,
        pendingTimeoutMs: 3500,

        enableVoice: true
    },

    requiresVersion: "2.1.0",

    start() {
        this._items = [];
        this._status = "INIT";
        this._lastError = null;

        this._pending = Object.create(null);
        this._lastToggleAt = Object.create(null);

        this.sendSocketNotification("HRS_CONFIG", { ...this.config });
    },

    getStyles() {
        return ["HueRoomStatus.css"];
    },

    notificationReceived(notification, payload) {
        if (!this.config.enableVoice) return;
        if (notification === "HUE_COMMAND") {
            this.sendSocketNotification("HRS_HUE_COMMAND", payload || {});
        }
    },

    _isConfigured() {
        if (!this.config.bridgeIp) return false;
        const v = String(this.config.apiVersion || "auto").toLowerCase();

        if (v === "v2") return !!this.config.hueApplicationKey;
        if (v === "v1") return !!this.config.userId;

        return !!(this.config.hueApplicationKey || this.config.userId);
    },

    _getPending(id) {
        const p = this._pending[id];
        if (!p) return null;
        if (Date.now() - p.startedAt > this.config.pendingTimeoutMs) {
            delete this._pending[id];
            return null;
        }
        return p;
    },

    _effectiveOn(item) {
        const p = this._getPending(item.id);
        return p ? !!p.desiredOn : !!item.on;
    },

    _setPending(id, desiredOn) {
        this._pending[id] = { desiredOn: !!desiredOn, startedAt: Date.now() };
        setTimeout(() => {
            const p = this._getPending(id);
            if (p) {
                delete this._pending[id];
                this.updateDom(0);
            }
        }, this.config.pendingTimeoutMs + 50);
    },

    _clearPending(id) {
        if (this._pending[id]) {
            delete this._pending[id];
            this.updateDom(0);
        }
    },

    _onRowClick(item) {
        if (!this.config.touchToggle) return;
        if (!item || !item.reachable) return;

        const now = Date.now();
        const last = this._lastToggleAt[item.id] || 0;
        if (now - last < this.config.toggleDebounceMs) return;
        this._lastToggleAt[item.id] = now;

        const desiredOn = !this._effectiveOn(item);

        if (this.config.optimisticUi) {
            this._setPending(item.id, desiredOn);
            this.updateDom(0);
        }

        this.sendSocketNotification("HRS_SET_STATE", {
            id: item.id,
            type: item.type || "light",
            on: desiredOn
        });
    },

    getDom() {
        const wrapper = document.createElement("div");
        wrapper.className = "hrs";

        if (this.config.showLabel) {
            const h = document.createElement("div");
            h.className = "hrs__header";
            h.textContent = this.config.header;
            wrapper.appendChild(h);
        }

        if (!this._isConfigured()) {
            const msg = document.createElement("div");
            msg.className = "hrs__error";
            msg.textContent = "HueRoomStatus: configure bridgeIp + (hueApplicationKey for v2 OR userId for v1).";
            wrapper.appendChild(msg);
            return wrapper;
        }

        if (this._status === "ERROR") {
            const msg = document.createElement("div");
            msg.className = "hrs__error";
            msg.textContent = this._lastError || "HueRoomStatus error.";
            wrapper.appendChild(msg);
            return wrapper;
        }

        if (!this._items || this._items.length === 0) {
            const msg = document.createElement("div");
            msg.className = "hrs__dim";
            msg.textContent = "No Hue items.";
            wrapper.appendChild(msg);
            return wrapper;
        }

        const list = document.createElement("div");
        list.className = "hrs__list";

        const items = this._items.slice(0, this.config.maxItems);

        for (const item of items) {
            if (this.config.showOnlyOn && !this._effectiveOn(item)) continue;
            if (!this.config.showUnreachable && !item.reachable) continue;

            const row = document.createElement("div");
            row.className = "hrs__row";

            const isPending = !!this._getPending(item.id);
            if (isPending) row.classList.add("hrs__row--pending");
            if (this.config.touchToggle && item.reachable) row.classList.add("hrs__row--clickable");

            const icon = document.createElement("i");
            icon.classList.add("fa", "hrs__icon");

            const effectiveOn = this._effectiveOn(item);

            if (!item.reachable) icon.classList.add("fa-times");
            else if (isPending) icon.classList.add("fa-circle-o-notch", "fa-spin");
            else if (effectiveOn) icon.classList.add("fa-lightbulb-o");
            else icon.classList.add("fa-adjust");

            if (this.config.colour && effectiveOn && item.reachable && item.rgb) {
                icon.style.color = item.rgb;
            }

            const name = document.createElement("span");
            name.className = "hrs__name";
            name.textContent = item.name;

            row.appendChild(icon);
            row.appendChild(name);

            if (this.config.touchToggle && item.reachable) {
                row.title = "Tap to toggle";
                row.onclick = () => this._onRowClick(item);
            }

            list.appendChild(row);
        }

        wrapper.appendChild(list);
        return wrapper;
    },

    socketNotificationReceived(notification, payload) {
        if (notification === "HRS_DATA") {
            this._status = "OK";
            this._lastError = null;
            this._items = (payload && Array.isArray(payload.items)) ? payload.items : [];
            this.updateDom(this.config.animationSpeed);
            return;
        }

        if (notification === "HRS_ERROR") {
            this._status = "ERROR";
            this._lastError = (payload && payload.message) ? payload.message : "Unknown error";
            this.updateDom(this.config.animationSpeed);
            return;
        }

        if (notification === "HRS_CMD_OK") {
            if (payload && payload.id) this._clearPending(String(payload.id));
            return;
        }

        if (notification === "HRS_CMD_ERROR") {
            if (payload && payload.id) this._clearPending(String(payload.id));
            this._status = "ERROR";
            this._lastError = (payload && payload.message) ? payload.message : "Command failed";
            this.updateDom(0);

            setTimeout(() => {
                if (this._status === "ERROR") {
                    this._status = "OK";
                    this._lastError = null;
                    this.updateDom(0);
                }
            }, 3500);
        }
    }
});
