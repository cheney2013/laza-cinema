(function() {
    const SPLAT = window.GSPLAT;

    /**
     * FlyControls: free roam for the gaussian viewer, same interface as PreciseOrbitControls
     * (update, setCameraTarget, getCameraTarget, resetRoll, dispose).
     *
     *   drag (left or right button)  turn the head          W S A D / arrows  forward, back, left, right
     *   Space / E                    rise                    Q / C             sink
     *   Shift                        run (x4)                wheel             change the walking speed
     *
     * Frame of the splats: x right, y DOWN, z forward (SHARP / FlashWorld after prune_ply), so "up" is -y.
     * The camera is placed from (position, yaw, pitch); yaw 0 looks down +z, positive yaw turns toward +x,
     * positive pitch looks up.  Speed is in splat units per second and is set from the scene size
     * (setSceneSize), because a FlashWorld route is 160 m long and a single-picture splat is a couple of metres.
     */
    class FlyControls {
        constructor(camera, canvas) {
            this.camera = camera;
            this.canvas = canvas;
            this.position = new SPLAT.Vector3(camera.position.x, camera.position.y, camera.position.z);
            this.yaw = 0;
            this.pitch = 0;
            this.roll = 0;
            this.baseSpeed = 1.0;      // units per second, set from the scene size
            this.speedMult = 1.0;      // changed with the wheel
            this.lookSpeed = 0.0035;   // radians per pixel
            this.keys = {};
            this.dragging = false;
            this.lastX = 0;
            this.lastY = 0;
            this.lastTime = performance.now();

            const alias = { ArrowUp: 'KeyW', ArrowDown: 'KeyS', ArrowLeft: 'KeyA', ArrowRight: 'KeyD' };
            const press = (code, on) => { this.keys[code] = on; };
            this._onKeyDown = (e) => {
                if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
                press(e.code, true);
                if (alias[e.code]) press(alias[e.code], true);
                // the real modifier state wins over whatever keyup we may have missed
                if (e.shiftKey === false) { press('ShiftLeft', false); press('ShiftRight', false); }
                if (e.code === 'Space') e.preventDefault();
            };
            this._onKeyUp = (e) => {
                press(e.code, false);
                if (alias[e.code]) press(alias[e.code], false);
                if (e.shiftKey === false) { press('ShiftLeft', false); press('ShiftRight', false); }
            };
            // keyup is not delivered once focus has left the window or the tab: let go of everything then.
            // (No timeout on held keys: with two keys down the system repeats only the last one.)
            this.releaseAll = () => { this.keys = {}; this.dragging = false; };
            this._onBlur = () => this.releaseAll();
            this._onVis = () => { if (document.hidden) this.releaseAll(); };
            window.addEventListener('blur', this._onBlur);
            document.addEventListener('visibilitychange', this._onVis);
            this._onDown = (e) => {
                this.dragging = true;
                this.lastX = e.clientX;
                this.lastY = e.clientY;
                const up = () => { this.dragging = false; window.removeEventListener('mouseup', up); };
                window.addEventListener('mouseup', up);
            };
            this._onMove = (e) => {
                if (!this.dragging) return;
                const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
                this.lastX = e.clientX;
                this.lastY = e.clientY;
                this.yaw += dx * this.lookSpeed;
                this.pitch -= dy * this.lookSpeed;
                const lim = Math.PI / 2 - 0.02;
                this.pitch = Math.min(Math.max(this.pitch, -lim), lim);
            };
            this._onWheel = (e) => {
                if (e.ctrlKey) return;
                this.speedMult *= e.deltaY < 0 ? 1.2 : 1 / 1.2;
                this.speedMult = Math.min(Math.max(this.speedMult, 0.02), 50);
            };
            this._noMenu = (e) => e.preventDefault();
            window.addEventListener('keydown', this._onKeyDown);
            window.addEventListener('keyup', this._onKeyUp);
            canvas.addEventListener('mousedown', this._onDown);
            canvas.addEventListener('mousemove', this._onMove);
            canvas.addEventListener('wheel', this._onWheel, { passive: true });
            canvas.addEventListener('contextmenu', this._noMenu);
        }

        forwardVector() {
            const cp = Math.cos(this.pitch);
            return new SPLAT.Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
        }

        setSceneSize(extent) {
            // walking pace: the whole scene in about 20 s
            this.baseSpeed = Math.max(extent / 20, 0.05);
        }

        update() {
            const now = performance.now();
            const dt = Math.min((now - this.lastTime) / 1000, 0.5);   // a heavy splat can run at a few frames a second
            this.lastTime = now;
            const run = (this.keys.ShiftLeft || this.keys.ShiftRight) ? 4 : 1;
            const step = this.baseSpeed * this.speedMult * run * dt;
            const f = this.forwardVector();
            const r = new SPLAT.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
            let p = this.position;
            if (this.keys.KeyW) p = p.add(f.multiply(step));
            if (this.keys.KeyS) p = p.subtract(f.multiply(step));
            if (this.keys.KeyD) p = p.add(r.multiply(step));
            if (this.keys.KeyA) p = p.subtract(r.multiply(step));
            if (this.keys.Space || this.keys.KeyE) p = new SPLAT.Vector3(p.x, p.y - step, p.z);   // up is -y
            if (this.keys.KeyQ || this.keys.KeyC) p = new SPLAT.Vector3(p.x, p.y + step, p.z);
            this.position = p;
            this.camera.position = new SPLAT.Vector3(p.x, p.y, p.z);
            this.camera.rotation = SPLAT.Quaternion.FromEuler(new SPLAT.Vector3(this.pitch, this.yaw, this.roll));
        }

        // Face the point t from where the camera is now (the viewer calls this after placing camera.position).
        setCameraTarget(t) {
            this.position = new SPLAT.Vector3(this.camera.position.x, this.camera.position.y, this.camera.position.z);
            const dx = t.x - this.position.x, dy = t.y - this.position.y, dz = t.z - this.position.z;
            this.yaw = Math.atan2(dx, dz);
            this.pitch = Math.atan2(-dy, Math.sqrt(dx * dx + dz * dz));
        }

        getCameraTarget() {
            return this.position.add(this.forwardVector().multiply(3));
        }

        resetRoll() { this.roll = 0; }

        dispose() {
            window.removeEventListener('keydown', this._onKeyDown);
            window.removeEventListener('keyup', this._onKeyUp);
            window.removeEventListener('blur', this._onBlur);
            document.removeEventListener('visibilitychange', this._onVis);
            this.canvas.removeEventListener('mousedown', this._onDown);
            this.canvas.removeEventListener('mousemove', this._onMove);
            this.canvas.removeEventListener('wheel', this._onWheel);
            this.canvas.removeEventListener('contextmenu', this._noMenu);
        }
    }

    window.FlyControls = FlyControls;
})();
