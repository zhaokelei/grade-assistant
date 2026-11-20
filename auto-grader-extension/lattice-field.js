/* lattice-field.js — 点阵 Field（Canvas 2D 本地实现）
   复刻 Lattice 点场行为：网格点集、指针推力、弹簧回位、热度泛橙、静止停机。
   无外部依赖，不加载任何网络资源。 */

(function (global) {
  'use strict';

  var ICON = {};

  function quantize(heat) {
    var q = Math.round(heat * 12) / 12;
    if (q < 0.02) q = 0;
    var key = 'q' + q;
    var hit = ICON[key];
    if (hit) return hit;
    var r = Math.round(236 + (255 - 236) * q);
    var g = Math.round(231 + (90 - 231) * q);
    var b = Math.round(218 + (31 - 218) * q);
    var a = 0.14 + 0.74 * q;
    ICON[key] = {
      style: 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(3) + ')',
      size: 1 + q * 1.2
    };
    return ICON[key];
  }

  function createLatticeField(canvas, options) {
    if (!canvas || !canvas.getContext) return null;
    var o = Object.assign(
      {
        pitch: 16,        // 点距
        maxPoints: 1600,  // 上限，超出则稀疏采样
        radius: 92,       // 指针影响半径
        push: 18,         // 最大推力
        alpha: 0.14,
        idleMs: 1800      // 静止多久后停机
      },
      options || {}
    );

    var ctx = canvas.getContext('2d');
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var pts = [];
    var width = 0;
    var height = 0;
    var pointer = { x: -9999, y: -9999, inside: false };
    var raf = 0;
    var running = false;
    var lastActive = 0;

    function build() {
      var rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var pitch = o.pitch;
      var cols = Math.ceil(width / pitch) + 1;
      var rows = Math.ceil(height / pitch) + 1;
      var ox = (width - (cols - 1) * pitch) / 2;
      var oy = (height - (rows - 1) * pitch) / 2;
      var total = cols * rows;
      var step = total > o.maxPoints ? Math.ceil(total / o.maxPoints) : 1;

      pts = [];
      for (var j = 0; j < rows; j++) {
        for (var i = 0; i < cols; i++) {
          if (step > 1 && (j * cols + i) % step !== 0) continue;
          var x = ox + i * pitch;
          var y = oy + j * pitch;
          pts.push({ bx: x, by: y, x: x, y: y, vx: 0, vy: 0, heat: 0 });
        }
      }
    }

    function frame() {
      raf = 0;
      ctx.clearRect(0, 0, width, height);
      var moving = false;
      var i, p;

      for (i = 0; i < pts.length; i++) {
        p = pts[i];
        var heat = 0;

        if (pointer.inside) {
          var dx = pointer.x - p.bx;
          var dy = pointer.y - p.by;
          var d2 = dx * dx + dy * dy;
          if (d2 < o.radius * o.radius && d2 > 0.01) {
            var d = Math.sqrt(d2);
            var t = 1 - d / o.radius;
            heat = t * t;
            var f = (o.push * heat) / d;
            p.vx -= dx * f * 0.05;
            p.vy -= dy * f * 0.05;
          }
        }

        // 弹簧回位
        p.vx += (p.bx - p.x) * 0.14;
        p.vy += (p.by - p.y) * 0.14;
        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;

        if (!moving && (Math.abs(p.vx) + Math.abs(p.vy)) > 0.015) moving = true;

        p.heat += (heat - p.heat) * 0.2;

        var st = quantize(p.heat);
        ctx.fillStyle = st.style;
        ctx.fillRect(p.x - st.size / 2, p.y - st.size / 2, st.size, st.size);
      }

      if (pointer.inside || moving || Date.now() - lastActive < o.idleMs) {
        raf = global.requestAnimationFrame(frame);
      } else {
        running = false;
      }
    }

    function start() {
      lastActive = Date.now();
      if (running) return;
      running = true;
      if (!raf) raf = global.requestAnimationFrame(frame);
    }

    function onMove(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      pointer.x = clientX - rect.left;
      pointer.y = clientY - rect.top;
      pointer.inside = true;
      start();
    }

    function onLeave() {
      pointer.inside = false;
      start();
    }

    build();
    start();

    global.addEventListener('pointermove', function (e) {
      onMove(e.clientX, e.clientY);
    }, { passive: true });
    global.addEventListener('pointerdown', function (e) {
      onMove(e.clientX, e.clientY);
    }, { passive: true });
    global.addEventListener('pointerup', function () {
      lastActive = Date.now();
    }, { passive: true });
    global.addEventListener('pointerleave', onLeave, { passive: true });
    global.addEventListener('blur', onLeave);

    var resizeTimer = 0;
    global.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        build();
        start();
      }, 160);
    });

    return { rebuild: build, count: function () { return pts.length; } };
  }

  global.createLatticeField = createLatticeField;
})(typeof window !== 'undefined' ? window : this);
