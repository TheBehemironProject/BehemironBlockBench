// UVEditor GL — 事件桥接层
// Sprint 1: 挂在 #uv_frame(container) 上做 pointer delegation;
//           只拦截 event.target 是 container 或 canvas 的场景,DOM 上 mesh_uv_face / cube_box_uv /
//           resize handle 等仍走原有 DOM 事件路径,避免影响。
// Sprint 2: hitTest 追加 box_uv_rects(矩形,映射回整个 element)与 mesh_faces(precise
//           point-in-polygon,而非仅 AABB —— 原 SVG polygon 命中就是精确多边形)。
//           box_uv 原有 @click.prevent="selectCube" 现在没有 DOM 元素可挂了,改在
//           onCaptureClick 里对命中 box_uv 的场景补一次 vue.selectCube(...) 重放。
// pointerdown 只做"发现命中就 stopPropagation"(阻止 Vue 在 #uv_viewport 上的框选逻辑误触发),
// 绝不 preventDefault —— 否则浏览器会抑制这次交互的兼容 mouseup,导致 dragFace 卡死跟着鼠标跑。
// 真正触发 dragFace 放在 mousedown/touchstart 里(与原 DOM 模板的 @mousedown.prevent /
// @touchstart.prevent 语义一致)。
// GPU picking(pickAt(x,y))原计划作为后续可选优化替换这里的 CPU hitTest,但当前 CPU 版本
// (AABB + 少量 point-in-polygon)对几千面级别的场景做线性扫描也就是次毫秒级,已经够用,
// 未来真的需要再回来做,不算欠账。

/**
 * @param {HTMLElement} container  #uv_frame 元素(delegator 宿主)
 * @param {HTMLCanvasElement} canvas 用于识别 event.target(不接事件,pointer-events:none)
 * @param {*} vue UVEditor.vue 实例
 * @param {() => any} getState 返回当前 drawState 快照
 */
export function attachUVGLEvents(container, canvas, vue, getState) {
	if (!container) return () => {};

	function localCoords(event) {
		const rect = container.getBoundingClientRect();
		return [
			event.clientX - rect.left,
			event.clientY - rect.top,
		];
	}

	function pointInPolygon(x, y, polygon) {
		// 射线法(ray casting),复刻原 SVG <polygon> 的精确命中(而非仅 AABB)。
		let inside = false;
		for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
			const xi = polygon[i][0], yi = polygon[i][1];
			const xj = polygon[j][0], yj = polygon[j][1];
			const intersect = ((yi > y) !== (yj > y))
				&& (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
			if (intersect) inside = !inside;
		}
		return inside;
	}

	function hitTest(x, y) {
		const state = getState();
		if (!state) return null;

		const faces = state.cube_faces || [];
		for (let i = faces.length - 1; i >= 0; i--) {
			const f = faces[i];
			if (f.unselected) continue;
			const a = f.aabb;
			if (x >= a[0] && x <= a[2] && y >= a[1] && y <= a[3]) {
				return { kind: 'cube_face', element: f.element, key: f.key };
			}
		}

		const rects = state.box_uv_rects || [];
		for (let i = rects.length - 1; i >= 0; i--) {
			const r = rects[i];
			if (r.unselected) continue;
			const a = r.aabb;
			if (x >= a[0] && x <= a[2] && y >= a[1] && y <= a[3]) {
				return { kind: 'box_uv', element: r.element };
			}
		}

		const meshes = state.mesh_faces || [];
		for (let i = meshes.length - 1; i >= 0; i--) {
			const m = meshes[i];
			const a = m.aabb;
			if (x < a[0] || x > a[2] || y < a[1] || y > a[3]) continue; // AABB 快筛
			if (pointInPolygon(x, y, m.polygon)) {
				return { kind: 'mesh_face', element: m.element, key: m.key };
			}
		}

		return null;
	}

	function isOwnedTarget(target) {
		// 只处理 target 是 container 自身或 canvas 的事件;
		// 其他 DOM 元素(mesh_uv_face 等)保留原路径。
		return target === container || target === canvas;
	}

	// Behemiron GL: canvas 是 pointer-events:none,点在一个 cube face 上时浏览器汇报的
	// event.target 就是 container(#uv_frame)本身 —— 跟"点在背景空白处"完全一样。
	// #uv_frame 上的 @click.stop="reverseSelect($event)" 用 event.target.id=='uv_frame' 判断
	// "背景点击",过去因为面是子 <div>、target 不等于 frame 而天然被排除;现在没有这层区分了。
	// mousedown→mouseup 只要 target 相同就必然还会补发一个原生 click,冒泡到 reverseSelect,
	// 用鼠标释放时的坐标重新做一次独立命中判断,把刚刚 dragFace/selectFace 的结果又冲掉。
	// 用「document 捕获阶段」拦一次性地吞掉这个 click(必须挂在祖先节点上 —— 挂在 container
	// 自身时,由于 target===container,capture/bubble 监听器按注册顺序在同一个"at target"
	// 阶段触发,Vue 的 click 监听器注册在先,我们即使用 capture:true 也来不及拦截)。
	// pendingClickHit 不只是个开关,还带着"这次要不要在 click 里补一个动作"的信息:
	// box_uv 原来的 @click.prevent="selectCube(...)" 挂在现在已经不存在的 DOM 元素上,
	// 迁到 canvas 后没有等价的 DOM click 目标了,所以借用这个吞点击的时机顺手重放一次。
	let pendingClickHit = null;
	function onCaptureClick(event) {
		if (!pendingClickHit) return;
		const hit = pendingClickHit;
		pendingClickHit = null;
		if (event.target !== container) return;
		event.stopPropagation();
		event.preventDefault();
		if (hit.kind === 'box_uv') {
			vue.selectCube(hit.element, event);
		}
	}

	function hasHit(event) {
		if (vue.touches_count) return false;
		if (vue.mode === 'paint') return false; // paint 模式下面框仅作视觉参考,不响应交互
		if (!isOwnedTarget(event.target)) return false;
		const [x, y] = localCoords(event);
		return hitTest(x, y);
	}

	// Behemiron GL: 只负责"发现命中就 stopPropagation",阻止 Vue 在 #uv_viewport 上的
	// @pointerdown(框选/dragFace(null,...) 逻辑)被误触发 —— canvas pointer-events:none 导致
	// 点在 face 上时 event.target 也是 container,跟"点在背景"没区别。
	// 关键: 这里绝不能调用 event.preventDefault()!Pointer Events 规范规定,一旦 pointerdown
	// 的默认动作被阻止,浏览器就不会再为这次交互派发兼容的 mouseup —— 而 dragFace 内部的
	// drag()/stop() 恰恰是监听 document 上的 mouseup 来结束拖拽的,mouseup 收不到,拖拽状态
	// 就会卡住,表现为"松手后面还跟着鼠标跑"。真正触发 dragFace 放到下面的 mousedown 里,
	// 普通 mousedown 没有这条"抑制后续兼容事件"的规则,可以放心 preventDefault。
	function onPointerDown(event) {
		if (event.which === 2 || event.which === 3) return;
		if (!hasHit(event)) return; // 冒泡至 uv_viewport.onPointerDown 处理 reverseSelect / startSelRect
		event.stopPropagation();
	}

	function onMouseDown(event) {
		pendingClickHit = null;
		if (event.which === 2 || event.which === 3) return;
		const hit = hasHit(event);
		if (!hit) return;
		event.preventDefault();
		event.stopPropagation();
		pendingClickHit = hit;
		// hit.key 对 box_uv 是 undefined —— dragFace(element, null, event) 与原 DOM
		// @mousedown.prevent="dragFace(element, null, $event)" 语义一致(内部据此跳过 selectFace)。
		vue.dragFace(hit.element, hit.key, event);
	}

	function onTouchStart(event) {
		const hit = hasHit(event);
		if (!hit) return;
		event.preventDefault();
		event.stopPropagation();
		vue.dragFace(hit.element, hit.key, event);
	}

	function onContextMenu(event) {
		const hit = hasHit(event);
		// 原设计只有 cube_uv_face 有 @contextmenu="selectFace(...)";box_uv / mesh_uv_face 没有。
		if (!hit || hit.kind !== 'cube_face') return;
		event.preventDefault();
		event.stopPropagation();
		vue.selectFace(hit.element, hit.key, event, true, false);
	}

	// Sprint 3: hover 状态。故意不走 Vue 的 $forceUpdate/响应式更新整条链路(那是给"选择/编辑"这类
	// 低频操作用的),而是直接改 vue.hover_key 这个普通字段 + 只调 scheduleGLRedraw()——
	// hover_key 从未出现在 template 里,Vue 的依赖收集不会因为改它而触发整个组件重新渲染,
	// 这里只想要"下一帧用新状态重画 canvas",避免 mousemove 高频触发时把主线程搭进去
	// (对应 [[uveditor-gl-hidden-panel-render-leak]] 那次教训:能不惊动 Vue 就不惊动)。
	function hoverKeyFor(hit) {
		if (hit.kind === 'box_uv') return hit.element.uuid + ':box_uv';
		return hit.element.uuid + ':' + hit.key;
	}

	function setHover(key) {
		if (vue.hover_key === key) return;
		vue.hover_key = key;
		vue.scheduleGLRedraw();
	}

	function onPointerMove(event) {
		if (vue.touches_count) return;
		if (vue.mode === 'paint' || !isOwnedTarget(event.target)) {
			setHover(null);
			return;
		}
		const [x, y] = localCoords(event);
		const hit = hitTest(x, y);
		setHover(hit ? hoverKeyFor(hit) : null);
	}

	function onPointerLeave() {
		setHover(null);
	}

	container.addEventListener('pointerdown', onPointerDown, true); // capture: 先于 vue 的 @pointerdown(仅拦截,不触发)
	container.addEventListener('mousedown', onMouseDown, true);     // 真正触发 dragFace 的地方
	container.addEventListener('touchstart', onTouchStart, true);
	container.addEventListener('contextmenu', onContextMenu, true);
	container.addEventListener('pointermove', onPointerMove);
	container.addEventListener('pointerleave', onPointerLeave);
	document.addEventListener('click', onCaptureClick, true); // 必须挂在 container 的祖先上,见 onCaptureClick 注释

	return function detach() {
		container.removeEventListener('pointerdown', onPointerDown, true);
		container.removeEventListener('mousedown', onMouseDown, true);
		container.removeEventListener('touchstart', onTouchStart, true);
		container.removeEventListener('contextmenu', onContextMenu, true);
		container.removeEventListener('pointermove', onPointerMove);
		container.removeEventListener('pointerleave', onPointerLeave);
		document.removeEventListener('click', onCaptureClick, true);
	};
}
