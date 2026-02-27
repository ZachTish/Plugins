import { Plugin, Notice } from "obsidian";
import { DeviceRoleManager, DeviceRole } from "./device-role-manager";

export default class TPSControllerPlugin extends Plugin {
    private deviceRoleManager: DeviceRoleManager;
    private statusBarEl: HTMLElement;

    async onload() {
        this.statusBarEl = this.addStatusBarItem();
        this.deviceRoleManager = new DeviceRoleManager(this.app, (role) => this.updateStatusBar(role));
        this.updateStatusBar(this.deviceRoleManager.role);

        this.addCommand({
            id: "set-device-role-controller",
            name: "Set as Controller (Automation Source)",
            callback: () => {
                this.deviceRoleManager.setRole("controller");
                new Notice("Device set to CONTROLLER.");
            }
        });

        this.addCommand({
            id: "set-device-role-replica",
            name: "Set as Replica (Passive)",
            callback: () => {
                this.deviceRoleManager.setRole("replica");
                new Notice("Device set to REPLICA.");
            }
        });

        // Expose API for other plugins
        (this as any).api = {
            isController: (): boolean => this.deviceRoleManager.isController(),
            getRole: (): DeviceRole => this.deviceRoleManager.role
        };

        // Also expose on window for debugging/legacy access if needed
        (window as any).TPS = { controller: (this as any).api };

        console.log("[TPS Controller] Plugin loaded.");
    }

    private updateStatusBar(role: DeviceRole) {
        if (role === "controller") {
            this.statusBarEl.setText("TPS: Controller");
            this.statusBarEl.setAttr("title", "This device runs automation tasks.");
            this.statusBarEl.addClass("mod-tps-controller");
        } else {
            this.statusBarEl.setText("TPS: Replica");
            this.statusBarEl.setAttr("title", "This device is passive (no background automation).");
            this.statusBarEl.removeClass("mod-tps-controller");
        }
    }

    onunload() {
        delete (this as any).api;
        delete (window as any).TPS;
    }
}
