/* global Module */

Module.register("MMM-HueRoomStatus", {
    defaults: {
        header: "Hue Lights",
        bridgeIp: "192.168.0.2",
        userId: "Q-pmyBMjEW345syvySPTaHl4em5SGws5kYGPOKDp",
        mode: "lights",
        refreshMs: 60 * 1000,
        animationSpeed: 1000,
        requestTimeoutMs: 8000,
        showOnlyOn: false,
        showLabel: true,
        colour: true,
        showUnreachable: true,
        maxItems: 12,
        touchToToggle: true
    },

    requiresVersion: "2.1.0",

    start() {
        this._items = [];
        this._status = "INIT";
        this._lastError = null;
        this._pendingIds = new Set();

        this.sendSocketNotification("HRS_CONFIG", {
            ...this.config
        });
    },

    getStyles() {
        return ["HueRoomStatus.css"];
    },

    notificationReceived(notification, payload) {
        if ((notification === "HUE_COMMAND" || notification === "HRS_COMMAND") && payload) {
            this.sendSocketNotification("HRS_COMMAND", payload);
            return;
        }

        if ((notification === "HUE_TOGGLE" || notification === "HRS_TOGGLE") && payload) {
            this.sendSocketNotification("HRS_TOGGLE", payload);
        }
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

        if (!this.config.bridgeIp || !this.config.userId) {
            const msg = document.createElement("div");
            msg.className = "hrs__error";
            msg.textContent = "HueRoomStatus: Missing bridgeIp and/or userId in config.";
            wrapper.appendChild(msg);
            return wrapper;
        }

        if (this._status === "ERROR") {
            const msg = document.createElement("div");
            msg.className = "hrs__error";
            msg.textContent = this._lastError || "HueRoomStatus: Error fetching Hue data.";
            wrapper.appendChild(msg);
        }

        const visibleItems = (this._items || [])
            .filter((item) => this.config.showUnreachable || item.reachable)
            .slice(0, this.config.maxItems);

        if (!visibleItems.length) {
            const msg = document.createElement("div");
            msg.className = "hrs__dim";
            msg.textContent = "No lights to display.";
            wrapper.appendChild(msg);
            return wrapper;
        }

        const list = document.createElement("div");
        list.className = "hrs__list";

        for (const item of visibleItems) {
            const row = document.createElement("div");
            row.className = "hrs__row";

            const canToggle = !!(
                this.config.touchToToggle &&
                item.type === "light" &&
                item.reachable &&
                !this._pendingIds.has(String(item.id))
            );

            if (canToggle) row.classList.add("hrs__row--clickable");
            if (this._pendingIds.has(String(item.id))) row.classList.add("hrs__row--pending");

            const icon = document.createElement("i");
            icon.classList.add("fa", "hrs__icon");

            if (!item.reachable) {
                icon.classList.add("fa-times");
            } else if (item.on) {
                icon.classList.add("fa-lightbulb-o");
            } else {
                icon.classList.add("fa-adjust");
            }

            if (this.config.colour && item.on && item.reachable && typeof item.rgb === "string" && item.rgb) {
                icon.style.color = item.rgb;
            }

            const name = document.createElement("span");
            name.className = "hrs__name";
            name.textContent = item.name;

            row.appendChild(icon);
            row.appendChild(name);

            if (canToggle) {
                row.onclick = () => {
                    this._pendingIds.add(String(item.id));
                    this.updateDom(0);

                    this.sendSocketNotification("HRS_TOGGLE", {
                        id: item.id,
                        on: !item.on
                    });

                    window.setTimeout(() => {
                        this._pendingIds.delete(String(item.id));
                        this.updateDom(0);
                    }, Math.max(1000, Number(this.config.requestTimeoutMs) || 8000));
                };
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
            this._items = Array.isArray(payload && payload.items) ? payload.items : [];
            this._pendingIds.clear();
            this.updateDom(this.config.animationSpeed);
            return;
        }

        if (notification === "HRS_ERROR") {
            this._status = "ERROR";
            this._lastError = payload && payload.message ? payload.message : "Unknown error";
            this._pendingIds.clear();
            this.updateDom(this.config.animationSpeed);
        }
    }
});