// UVEditor GL — Three.js 场景装配 + rAF 渲染循环 + 生命周期
// Sprint 1: 装配 TextureLayer + FaceLayer + OutlineLayer;事件层接 pointerdown/contextmenu;
//           拆掉 UV_RENDER_ELEMENT_CAP 由 uv.js 侧完成,本模块不做截断。
// Sprint 2: 追加 MeshFaceLayer + MeshOutlineLayer(mesh_uv_face);box_uv 并入 FaceLayer/OutlineLayer。
//
// 用法(在 UVEditor.vue.mounted 里调用):
//   const gl = createUVGLScene({ container: this.$refs.frame, canvas: this.$refs.gl_canvas, vue: this });
//   // ...state 变化时:
//   gl.scheduleRedraw();
//   // 卸载时:
//   gl.dispose();

import { buildDrawState } from './UVGLState.js';
import { TextureLayer, FaceLayer, OutlineLayer, MeshFaceLayer, MeshOutlineLayer, OverlayLayer } from './UVGLLayers.js';
import { attachUVGLEvents } from './UVGLEvents.js';

export function createUVGLScene({ container, canvas, vue }) {
	// --- Renderer ---
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		premultipliedAlpha: true,
		powerPreference: 'high-performance',
		preserveDrawingBuffer: false,
	});
	renderer.setPixelRatio(window.devicePixelRatio || 1);
	renderer.setClearColor(0x000000, 0); // 透明底,底层 CSS 显示 checkerboard
	renderer.sortObjects = false;

	// --- Scene + Camera(屏幕像素坐标系, y 向下) ---
	const scene = new THREE.Scene();
	let width = 1, height = 1;
	const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
	camera.position.z = 10;

	// --- Layers ---
	const textureLayer     = new TextureLayer(scene);
	const faceLayer        = new FaceLayer(scene);        // cube_uv_face + box_uv_rects(Sprint 2 合并)
	const outlineLayer     = new OutlineLayer(scene);      // 同上的描边
	const meshFaceLayer    = new MeshFaceLayer(scene);     // Sprint 2: mesh_uv_face 三角化填色
	const meshOutlineLayer = new MeshOutlineLayer(scene);  // Sprint 2: mesh_uv_face 描边
	const overlayLayer     = new OverlayLayer(scene);      // Sprint 3: 框选矩形 + 对齐辅助线

	// --- Palette (从 CSS 变量抽色) ---
	let palette = readThemePalette(container);

	// --- State snapshot (供事件层 hitTest 读取) ---
	let currentState = { cube_faces: [] };

	// --- rAF 合并渲染 ---
	let dirty = true;
	let raf_handle = 0;
	let disposed = false;

	function scheduleRedraw() {
		if (dirty || disposed) {
			if (raf_handle) return;
		}
		dirty = true;
		if (raf_handle) return;
		raf_handle = requestAnimationFrame(_render);
	}

	function _render() {
		raf_handle = 0;
		if (disposed) return;
		dirty = false;

		// 1. 重抽 palette(每帧一次成本可忽略,主题切换即时生效)
		palette = readThemePalette(container);

		// 2. 构建 draw list
		const drawState = buildDrawState(vue);
		currentState = drawState;

		// 3. 相机同步 inner_width / inner_height
		if (drawState.inner_width !== width || drawState.inner_height !== height) {
			width  = Math.max(1, drawState.inner_width  | 0);
			height = Math.max(1, drawState.inner_height | 0);
			_syncCameraToSize(width, height);
			_syncRendererSize(width, height);
		}

		// 4. 更新各层几何
		textureLayer.update(drawState, palette);
		faceLayer.update(drawState, palette);
		outlineLayer.update(drawState, palette);
		meshFaceLayer.update(drawState, palette);
		meshOutlineLayer.update(drawState, palette);
		overlayLayer.update(drawState, palette);

		// 5. 绘制
		renderer.render(scene, camera);
	}

	function _syncCameraToSize(w, h) {
		camera.left = 0;
		camera.right = w;
		camera.top = 0;
		camera.bottom = h;
		camera.updateProjectionMatrix();
	}

	function _syncRendererSize(w, h) {
		const dpr = window.devicePixelRatio || 1;
		if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
		renderer.setSize(w, h, false); // false: 不改 style 尺寸,由 CSS 100% 控制
	}

	// --- ResizeObserver: 监视容器像素尺寸变化,触发重绘 ---
	const resizeObserver = new ResizeObserver(() => scheduleRedraw());
	if (container) resizeObserver.observe(container);

	// --- DPR 变化(多屏拖动) ---
	let dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
	function onDprChange() {
		scheduleRedraw();
		// 重新绑定 media query(DPR 已变,阈值变)
		dprMedia.removeEventListener('change', onDprChange);
		dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		dprMedia.addEventListener('change', onDprChange);
	}
	dprMedia.addEventListener('change', onDprChange);

	// --- 事件桥接 (delegator 挂 container,而非 canvas;canvas 保持 pointer-events:none) ---
	const detachEvents = attachUVGLEvents(container, canvas, vue, () => currentState);

	// --- 首次渲染 ---
	scheduleRedraw();

	// --- 对外接口 ---
	return {
		scheduleRedraw,
		render: _render,
		getCurrentState() { return currentState; },
		dispose() {
			if (disposed) return;
			disposed = true;
			if (raf_handle) cancelAnimationFrame(raf_handle);
			detachEvents();
			resizeObserver.disconnect();
			dprMedia.removeEventListener('change', onDprChange);
			textureLayer.dispose();
			faceLayer.dispose();
			outlineLayer.dispose();
			meshFaceLayer.dispose();
			meshOutlineLayer.dispose();
			overlayLayer.dispose();
			// 场景内所有子物体已由 Layer.dispose 移除
			renderer.dispose();
			// canvas 保留(由 Vue template 管);清空 GL context
		},
	};
}

// -------------------- palette helper --------------------

/**
 * 从 CSS 变量抽出面的填色 / 描边调色板。
 * palette.stroke[state]: [r,g,b,a] 0..1
 * palette.fill  [state]: [r,g,b,a] 0..1
 */
function readThemePalette(container) {
	const root = container || document.documentElement;
	const style = getComputedStyle(root);

	function raw(name, fallback) {
		const v = style.getPropertyValue(name).trim();
		return v || fallback;
	}
	function toRgba(cssColor, alpha) {
		if (!cssColor) return [1, 1, 1, alpha];
		try {
			// 用临时 dom 让浏览器解析成 rgb()
			const tmp = document.createElement('div');
			tmp.style.color = cssColor;
			tmp.style.display = 'none';
			document.body.appendChild(tmp);
			const rgb = getComputedStyle(tmp).color;
			document.body.removeChild(tmp);
			const m = rgb.match(/(\d+\.?\d*)/g);
			if (!m || m.length < 3) return [1, 1, 1, alpha];
			return [+m[0] / 255, +m[1] / 255, +m[2] / 255, alpha];
		} catch (e) {
			return [1, 1, 1, alpha];
		}
	}

	// 状态: UNSELECTED / DEFAULT / HOVER / SELECTED / SELECTED_PRIMARY
	const stroke = [
		toRgba(raw('--color-uv-unselected', ''), 1),                 // 0 UNSELECTED
		toRgba(raw('--color-text',          '#eee'), 1),             // 1 DEFAULT
		toRgba(raw('--color-uv-hover',      raw('--color-uv-selected', '#fff')), 1), // 2 HOVER
		toRgba(raw('--color-uv-selected',   '#fff'), 1),             // 3 SELECTED
		toRgba(raw('--color-accent',        '#39f'), 1),             // 4 SELECTED_PRIMARY
	];
	const fill = [
		[0, 0, 0, 0],                                                // 0 UNSELECTED  (仅描边)
		[0, 0, 0, 0],                                                // 1 DEFAULT     (仅描边)
		toRgba(raw('--color-uv-background-hover', '#ffffff'), 0.10), // 2 HOVER
		toRgba(raw('--color-uv-background',       '#ffffff'), 0.14), // 3 SELECTED
		toRgba(raw('--color-accent',              '#3399ff'), 0.20), // 4 SELECTED_PRIMARY
	];
	return { stroke, fill };
}
