Module.register("MMM-HueRoomStatus", {
    defaults: {
        header: "Hue Lights",
        bridgeIp: "",
        userId: "",
        updateInterval: 30 * 1000,
        touchToToggle: true
    },

    start() {
        this.items = [];
        this.error = null;
        this.sendSocketNotification("HUE_INIT", this.config);
    },

    getStyles() {
        return ["HueRoomStatus.css"];
    },

    notificationReceived(notification, payload) {
        if (notification === "HUE_COMMAND" && payload) {
            this.sendSocketNotification("HUE_COMMAND", payload);
        }
    },

    socketNotificationReceived(notification, payload) {
        if (notification === "HUE_STATE") {
            this.items = Array.isArray(payload && payload.items) ? payload.items : [];
            this.error = null;
            this.updateDom(0);
            return;
        }

        if (notification === "HUE_ERROR") {
            this.error = payload && payload.message ? payload.message : "Hue error";
            this.updateDom(0);
        }
    },

    getDom() {
        const wrapper = document.createElement("div");

        if (this.error) {
            wrapper.textContent = this.error;
            return wrapper;
        }

        if (!this.items.length) {
            wrapper.textContent = "No lights to display";
            return wrapper;
        }

        for (const item of this.items) {
            const row = document.createElement("div");
            row.className = "small";

            const dot = document.createElement("span");
            dot.textContent = item.on ? "● " : "○ ";
            if (item.rgb && item.on) dot.style.color = item.rgb;

            const text = document.createElement("span");
            text.textContent = `${item.name} (${item.on ? "On" : "Off"})`;

            row.appendChild(dot);
            row.appendChild(text);

            if (this.config.touchToToggle) {
                row.style.cursor = "pointer";
                row.onclick = () => {
                    this.sendSocketNotification("HUE_TOGGLE", {
                        id: item.id,
                        on: !item.on
                    });
                };
            }

            wrapper.appendChild(row);
        }

        return wrapper;
    }
});