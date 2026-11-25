/* =========================================================
   แบบจำลอง 3 มิติของเชื้อ Treponema pallidum (ภาพจำลองเพื่อการเรียนรู้)
   วาดด้วย canvas ล้วน ไม่ต้องโหลดไลบรารีเพิ่ม · ลากเพื่อหมุน · ลูกกลิ้ง/ปุ่ม +/− เพื่อซูม · ลูกศรบนคีย์บอร์ด
   ปิดได้ใน config.js: GERM3D: false · เปลี่ยนหัวข้อที่แสดง: GERM3D_TOPIC
   ========================================================= */
(function () {
  "use strict";
  var TAU = Math.PI * 2;
  var live = [];
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var PAL = {
    real: { bg0: "#1C2A31", bg1: "#0A1014", hi: "#F2FBFD", base: "#8FBBC9", lo: "#1F3D49", flag: "#F3C46B", text: "#D7E6EB" },
    site: { bg0: "#FBF8F5", bg1: "#EFE5DF", hi: "#FFF1F4", base: "#E68FA0", lo: "#8E3446", flag: "#5E6B4B", text: "#3D4335" }
  };

  function sprite(P) {
    var s = document.createElement("canvas"); s.width = s.height = 96;
    var g = s.getContext("2d"), gr = g.createRadialGradient(34, 32, 4, 48, 48, 48);
    gr.addColorStop(0, P.hi); gr.addColorStop(0.35, P.base); gr.addColorStop(1, P.lo);
    g.fillStyle = gr; g.beginPath(); g.arc(48, 48, 47, 0, TAU); g.fill();
    return s;
  }

  function mount(root) {
    if (!root) return;
    root.innerHTML =
      '<div class="germ-stage"><canvas tabindex="0" role="img" aria-label="แบบจำลอง 3 มิติของเชื้อ Treponema pallidum ลำตัวเป็นเกลียวคล้ายสว่าน ลากหรือกดลูกศรเพื่อหมุน กด + หรือ − เพื่อซูม"></canvas>' +
      '<span class="germ-hint">ลากเพื่อหมุน · เลื่อนลูกกลิ้งเพื่อซูม</span></div>' +
      '<div class="germ-bar"><div class="seg" role="group" aria-label="รูปแบบภาพ">' +
      '<button type="button" data-look="real" aria-pressed="true">สมจริง</button><button type="button" data-look="site" aria-pressed="false">สีของเว็บ</button></div>' +
      '<div class="germ-btns"><button type="button" class="btn btn-sm btn-secondary" data-act="flag" aria-pressed="false">แสดงแฟลเจลลา</button>' +
      '<button type="button" class="btn btn-sm btn-secondary" data-act="reset">มุมเริ่มต้น</button>' +
      '<button type="button" class="btn btn-sm btn-primary" data-act="auto" aria-pressed="' + (!reduce) + '">' + (reduce ? "หมุนอัตโนมัติ" : "หยุดหมุน") + "</button></div></div>" +
      '<p class="germ-cap">ภาพจำลองเพื่อการเรียนรู้ ขยายความหนาของลำตัวให้มองเห็นง่าย เชื้อจริงยาว 6–15 ไมโครเมตร กว้างเพียง 0.1–0.2 ไมโครเมตร</p>';

    var cv = root.querySelector("canvas"), ctx = cv.getContext("2d"), hint = root.querySelector(".germ-hint");
    var st = { look: "real", auto: !reduce, flag: false, yaw: -0.55, pitch: 0.32, zoom: 1, phase: 0, drag: null, visible: true, raf: 0, dpr: 1, spr: null, sprFor: "" };

    function fit() {
      var r = cv.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d)); st.dpr = d;
      draw();
    }
    var ro = window.ResizeObserver ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(cv); else window.addEventListener("resize", fit);
    var io = window.IntersectionObserver ? new IntersectionObserver(function (en) { st.visible = en[0].isIntersecting; if (st.visible) kick(); }) : null;
    if (io) io.observe(cv);

    cv.addEventListener("pointerdown", function (e) { st.drag = { x: e.clientX, y: e.clientY, yaw: st.yaw, pitch: st.pitch }; try { cv.setPointerCapture(e.pointerId); } catch (_) {} kick(); });
    cv.addEventListener("pointermove", function (e) {
      if (!st.drag) return;
      st.yaw = st.drag.yaw + (e.clientX - st.drag.x) * 0.01;
      st.pitch = Math.max(-1.45, Math.min(1.45, st.drag.pitch + (e.clientY - st.drag.y) * 0.01));
      kick();
    });
    var up = function () { st.drag = null; };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", function (e) { e.preventDefault(); st.zoom = Math.max(0.6, Math.min(2.4, st.zoom * Math.exp(-e.deltaY * 0.0012))); kick(); }, { passive: false });
    cv.addEventListener("keydown", function (e) {
      var k = e.key;
      if (k === "ArrowLeft") st.yaw -= 0.15; else if (k === "ArrowRight") st.yaw += 0.15;
      else if (k === "ArrowUp") st.pitch = Math.max(-1.45, st.pitch - 0.15); else if (k === "ArrowDown") st.pitch = Math.min(1.45, st.pitch + 0.15);
      else if (k === "+" || k === "=") st.zoom = Math.min(2.4, st.zoom * 1.1); else if (k === "-") st.zoom = Math.max(0.6, st.zoom / 1.1);
      else return;
      e.preventDefault(); kick();
    });
    root.querySelector(".germ-bar").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-look")) {
        st.look = b.getAttribute("data-look");
        root.querySelectorAll("[data-look]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        root.classList.toggle("is-site", st.look === "site");
      }
      var a = b.getAttribute("data-act");
      if (a === "flag") { st.flag = !st.flag; b.setAttribute("aria-pressed", String(st.flag)); b.textContent = st.flag ? "ซ่อนแฟลเจลลา" : "แสดงแฟลเจลลา"; }
      if (a === "reset") { st.yaw = -0.55; st.pitch = 0.32; st.zoom = 1; }
      if (a === "auto") { st.auto = !st.auto; b.setAttribute("aria-pressed", String(st.auto)); b.textContent = st.auto ? "หยุดหมุน" : "หมุนอัตโนมัติ"; }
      kick();
    });

    function animating() { return st.visible && !document.hidden && (st.auto || !!st.drag); }
    function loop() {
      st.raf = 0;
      if (st.auto && !st.drag) st.yaw += 0.0045;
      if (st.auto) st.phase += 0.035;
      draw();
      if (animating()) st.raf = requestAnimationFrame(loop);
    }
    function kick() { if (!st.raf) st.raf = requestAnimationFrame(loop); }
    document.addEventListener("visibilitychange", kick);

    function draw() {
      var W = cv.width, H = cv.height, d = st.dpr; if (W < 2 || H < 2) return;
      var P = PAL[st.look];
      if (st.sprFor !== st.look) { st.spr = sprite(P); st.sprFor = st.look; }
      hint.style.background = st.look === "site" ? "rgba(35,40,29,.08)" : "rgba(255,255,255,.12)";
      hint.style.color = st.look === "site" ? "#3D4335" : "#E3EEF1";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      var bg = ctx.createRadialGradient(W * 0.5, H * 0.45, 10, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
      bg.addColorStop(0, P.bg0); bg.addColorStop(1, P.bg1);
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

      var coils = 10, A = 0.021, R = 0.0095, scale = Math.min(W * 0.82, H * 1.6) * st.zoom, cam = 2.4;
      var cy = Math.cos(st.yaw), sy = Math.sin(st.yaw), cp = Math.cos(st.pitch), sp = Math.sin(st.pitch), ph = st.phase;
      function proj(x, y, z) {
        var x1 = x * cy + z * sy, z1 = -x * sy + z * cy, y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp, s = cam / (cam - z2);
        return { x: W / 2 + x1 * scale * s, y: H / 2 + y2 * scale * s, z: z2, s: s };
      }
      function center(t) { var a = TAU * coils * t + ph; return [t - 0.5, A * Math.cos(a), A * Math.sin(a)]; }
      function taper(t) { return Math.pow(Math.min(1, t / 0.05, (1 - t) / 0.05), 0.6); }

      var pts = [], N = coils * 70, i, t, c, p;
      for (i = 0; i <= N; i++) {
        t = i / N; c = center(t); p = proj(c[0], c[1], c[2]);
        pts.push({ x: p.x, y: p.y, z: p.z, r: Math.max(0.6, R * taper(t) * scale * p.s), f: 0 });
      }
      if (st.flag) {
        var M = coils * 160, rr = R * 0.92, segs = [[0.04, 0.62, 0], [0.38, 0.96, Math.PI]];
        segs.forEach(function (sg) {
          for (var j = 0; j <= M; j++) {
            var tt = sg[0] + (sg[1] - sg[0]) * j / M, c1 = center(tt), c2 = center(tt + 0.0005);
            var tx = c2[0] - c1[0], ty = c2[1] - c1[1], tz = c2[2] - c1[2], tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
            var ny = tz, nz = -ty, nl = Math.hypot(ny, nz) || 1; ny /= nl; nz /= nl;
            var bx = ty * nz - tz * ny, by = -tx * nz, bz = tx * ny;
            var th = TAU * 3.2 * tt + sg[2], co = Math.cos(th), si = Math.sin(th);
            var q = proj(c1[0] + rr * (bx * si), c1[1] + rr * (ny * co + by * si), c1[2] + rr * (nz * co + bz * si));
            pts.push({ x: q.x, y: q.y, z: q.z + 0.0001, r: Math.max(0.7, 1.1 * d * q.s), f: 1 });
          }
        });
      }
      pts.sort(function (a, b) { return a.z - b.z; });
      for (i = 0; i < pts.length; i++) {
        var q2 = pts[i], near = Math.max(0, Math.min(1, q2.z + 0.5));
        ctx.globalAlpha = st.look === "site" ? 0.82 + 0.18 * near : 0.55 + 0.45 * near;
        if (q2.f) { ctx.fillStyle = P.flag; ctx.beginPath(); ctx.arc(q2.x, q2.y, q2.r, 0, TAU); ctx.fill(); }
        else ctx.drawImage(st.spr, q2.x - q2.r, q2.y - q2.r, q2.r * 2, q2.r * 2);
      }
      ctx.globalAlpha = 1;
      // ขีดบอกขนาด (ความยาวทั้งตัวในภาพ ≈ 11 ไมโครเมตร)
      var um = scale / 11, x0 = 18 * d, y0 = H - 22 * d;
      ctx.strokeStyle = P.text; ctx.lineWidth = 2 * d; ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x0 + um, y0);
      ctx.moveTo(x0, y0 - 5 * d); ctx.lineTo(x0, y0 + 5 * d); ctx.moveTo(x0 + um, y0 - 5 * d); ctx.lineTo(x0 + um, y0 + 5 * d); ctx.stroke();
      ctx.fillStyle = P.text; ctx.font = "600 " + Math.round(12 * d) + 'px "IBM Plex Sans Thai", system-ui, sans-serif';
      ctx.fillText("≈ 1 ไมโครเมตร", x0, y0 - 10 * d);
    }

    fit(); kick();
    var inst = {
      root: root,
      destroy: function () {
        if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0; st.visible = false;
        if (ro) ro.disconnect(); if (io) io.disconnect();
        document.removeEventListener("visibilitychange", kick);
      }
    };
    live.push(inst);
    return inst;
  }

  window.Germ3D = {
    mount: mount,
    unmountAll: function () { live.forEach(function (x) { x.destroy(); }); live = []; }
  };
})();
