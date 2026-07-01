// UVEditor GL — 从 UVEditor.vue 抽状态并构建 draw list
// Sprint 1 处理 cube_uv_face（非 box_uv、非 mesh）;
// Sprint 2 补上 box_uv(展开十字矩形) + mesh_uv_face(多边形三角化)。
// draw list 是一个纯数据快照,不持有 Three.js 对象,由 Layers 消费。
//
// 单位约定：所有 aabb / offset / size / polygon 坐标都已换算成"屏幕像素坐标系"（对齐 inner_width/height）。

import { FACE_STATE } from './UVGLShaders.js';

/**
 * @param {*} vue UVEditor.vue 实例（BB Vue 2 组件 data 直连）
 * @returns {{
 *   uv_resolution: [number, number],
 *   inner_width: number,
 *   inner_height: number,
 *   texture: any,
 *   mode: string,
 *   uv_overlay: boolean,
 *   box_uv: boolean,
 *   display_uv: string,
 *   cube_faces: Array<CubeFaceDraw>,
 *   box_uv_rects: Array<BoxUVRectDraw>,   // Sprint 2: 拍平的展开十字矩形,多个属于同一 element
 *   mesh_faces: Array<MeshFaceDraw>,      // Sprint 2: 每个 face 一个三角化 + 描边多边形
 *   hover_key: string|null,
 * }}
 */
export function buildDrawState(vue) {
	const uv_resolution = vue.uv_resolution;
	const inner_width = vue.inner_width;
	const inner_height = vue.inner_height;
	const mode = vue.mode;
	const uv_overlay = vue.uv_overlay;
	const display_uv = vue.display_uv;
	const box_uv = vue.box_uv;
	const texture = vue.texture;
	const hover_key = vue.hover_key || null;

	const cube_faces = [];
	const box_uv_rects = [];
	const mesh_faces = [];

	// px_x/px_y 只依赖 uv_resolution/inner_width/inner_height,跟 mode 无关,
	// selection_rect / helper_lines 原模板也没有按 mode 门控,所以提到早退分支之前算。
	const px_x = inner_width  / uv_resolution[0];
	const px_y = inner_height / uv_resolution[1];
	const selection_rect = buildSelectionRect(vue, px_x, px_y);
	const helper_lines   = buildHelperLines(vue, px_x, px_y);

	// 未启用 uv 面渲染时直接返回空(面/box/mesh 都不显示,但 selection_rect/helper_lines 仍照常算)
	if (mode !== 'uv' && !uv_overlay) {
		return {
			uv_resolution, inner_width, inner_height, texture,
			mode, uv_overlay, box_uv, display_uv,
			cube_faces, box_uv_rects, mesh_faces,
			selection_rect, helper_lines,
			hover_key,
		};
	}

	const mappable = vue.mappable_elements || [];
	const all_mappable = vue.all_mappable_elements || [];
	const list = (display_uv === 'all_elements' || mode === 'paint')
		? all_mappable
		: mappable;

	for (const element of list) {
		if (!element || !element.faces) continue;
		if (!element.getTypeBehavior || !element.getTypeBehavior('cube_faces')) continue;
		if (element.box_uv) continue; // Sprint 2 处理

		const in_mappable = mappable.includes(element);
		const supports_face_select = element.getTypeBehavior('select_faces') !== false;
		const selected_faces = readSelectedFaces(vue, element);

		for (const key in element.faces) {
			const face = element.faces[key];
			if (!face) continue;
			if (face.texture === null) continue;
			// 复刻旧模板: (getTexture()==texture || texture==0) && (显示条件)
			const face_tex = face.getTexture && face.getTexture();
			if (!(face_tex === texture || texture === 0)) continue;

			const face_selected = selected_faces.includes(key);
			// 复刻旧模板: display_uv === 'selected_faces' && mode!='paint' && 未选中 && 支持面选择 → 跳过
			if (display_uv === 'selected_faces' && mode !== 'paint'
				&& !face_selected && supports_face_select) continue;

			const unselected = (display_uv === 'all_elements' && !in_mappable);
			const hovered = (hover_key === element.uuid + ':' + key);

			const uv = face.uv;
			const x0 = Math.min(uv[0], uv[2]);
			const y0 = Math.min(uv[1], uv[3]);
			const size = face.uv_size; // [w, h]
			const abs_w = Math.abs(size[0]);
			const abs_h = Math.abs(size[1]);

			let state;
			if (unselected) {
				state = FACE_STATE.UNSELECTED;
			} else if (face_selected && mode === 'uv') {
				state = FACE_STATE.SELECTED_PRIMARY;
			} else if (face_selected) {
				state = FACE_STATE.SELECTED;
			} else if (hovered) {
				state = FACE_STATE.HOVER;
			} else {
				state = FACE_STATE.DEFAULT;
			}

			cube_faces.push({
				element,
				key,
				face,
				offset: [x0 * px_x, y0 * px_y],
				size: [abs_w * px_x, abs_h * px_y],
				aabb: [
					x0 * px_x, y0 * px_y,
					x0 * px_x + abs_w * px_x,
					y0 * px_y + abs_h * px_y,
				],
				state,
				unselected,
				selected: face_selected,
				hovered,
				rotation: face.rotation | 0,
			});
		}
	}

	// Sprint 2: box_uv 展开十字矩形
	for (const element of list) {
		if (!element || !element.getTypeBehavior || !element.getTypeBehavior('cube_faces') || !element.box_uv) continue;

		const unselected = (display_uv === 'all_elements' && !mappable.includes(element));
		const hovered = (hover_key === element.uuid + ':box_uv');
		const state = unselected ? FACE_STATE.UNSELECTED : (hovered ? FACE_STATE.HOVER : FACE_STATE.DEFAULT);

		const ox = element.uv_offset[0];
		const oy = element.uv_offset[1];
		for (const r of computeBoxUVRects(element)) {
			const x0 = (ox + r.left) * px_x;
			const y0 = (oy + r.top) * px_y;
			const w = r.width * px_x;
			const h = r.height * px_y;
			box_uv_rects.push({
				element,
				offset: [x0, y0],
				size: [w, h],
				aabb: [x0, y0, x0 + w, y0 + h],
				state,
				unselected,
				hovered,
			});
		}
	}

	// Sprint 2: mesh_uv_face 三角化(fan,假设凸多边形 —— 仓库无 earcut,凹面 mesh face 是已知限制)
	for (const element of list) {
		if (!element || element.type !== 'mesh') continue;

		const faces = vue.filterMeshFaces ? vue.filterMeshFaces(element) : element.faces;
		const selected_faces = readSelectedFaces(vue, element);

		for (const key in faces) {
			const face = faces[key];
			if (!face || !face.vertices || face.vertices.length <= 2) continue;
			const face_tex = face.getTexture && face.getTexture();
			// 原模板是 `face.getTexture() == texture`(宽松相等)。face.getTexture() 在没有
			// 单独指定纹理时会返回 false(而非 undefined),texture===0(Format.single_texture
			// 等场景的哨兵值)时 `false == 0` 宽松相等成立 —— 之前这里错用了严格 !==,
			// 导致这类 mesh face 被误判"纹理不匹配"整体不显示。补上跟 cube_faces 一样的
			// `|| texture === 0` 分支,不依赖宽松相等,行为等价且更明确。
			if (!(face_tex === texture || texture === 0)) continue;

			const face_selected = selected_faces.includes(key);
			// 复刻旧模板: display_uv === 'selected_faces' && mode != 'paint' && 未选中 → 跳过(mesh 没有 select_faces 例外)
			if (display_uv === 'selected_faces' && mode !== 'paint' && !face_selected) continue;

			const hovered = (hover_key === element.uuid + ':' + key);
			const state = face_selected ? FACE_STATE.SELECTED : (hovered ? FACE_STATE.HOVER : FACE_STATE.DEFAULT);

			const sorted = face.getSortedVertices ? face.getSortedVertices() : face.vertices;
			const polygon = [];
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const vkey of sorted) {
				const uv = face.uv[vkey];
				const px = uv[0] * px_x;
				const py = uv[1] * px_y;
				polygon.push([px, py]);
				if (px < minX) minX = px;
				if (px > maxX) maxX = px;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;
			}
			// fan 三角化,从第 0 个顶点出发 —— 凸多边形正确,凹多边形会有瑕疵(Sprint 2 已知限制)
			const triangles = [];
			for (let i = 1; i < polygon.length - 1; i++) {
				triangles.push(polygon[0], polygon[i], polygon[i + 1]);
			}

			mesh_faces.push({
				element,
				key,
				face,
				polygon,
				triangles,
				aabb: [minX, minY, maxX, maxY],
				state,
				selected: face_selected,
				hovered,
			});
		}
	}

	return {
		uv_resolution, inner_width, inner_height, texture,
		mode, uv_overlay, box_uv, display_uv,
		cube_faces,
		box_uv_rects,
		mesh_faces,
		selection_rect,
		helper_lines,
		hover_key,
	};
}

// Sprint 3: 框选矩形(selection_rect)—— 纯视觉 overlay,原模板 v-if="selection_rect.active",
// 没有 mode 门控,自身也没有任何交互(pointer-events: none)。
function buildSelectionRect(vue, px_x, px_y) {
	const rect = vue.selection_rect;
	if (!rect || !rect.active) return { active: false, x: 0, y: 0, width: 0, height: 0 };
	return {
		active: true,
		x: rect.pos_x * px_x,
		y: rect.pos_y * px_y,
		width: rect.width * px_x,
		height: rect.height * px_y,
	};
}

// Sprint 3: 对齐辅助线(helper_lines)—— 同样是纯视觉 overlay,x/y < 0 表示不显示对应方向的线。
function buildHelperLines(vue, px_x, px_y) {
	const hl = vue.helper_lines;
	if (!hl) return { x: -1, y: -1 };
	return {
		x: hl.x >= 0 ? hl.x * px_x : -1,
		y: hl.y >= 0 ? hl.y * px_y : -1,
	};
}

// Sprint 2: box_uv 展开十字的 4 个矩形(UV 单位,相对 element.uv_offset)。
// 精确复刻原 DOM 模板里的 4 个 <div> 几何(uv_fill × 2 + 侧边 × 1 + 右下角 × 1),
// 忽略原模板里 -1px/+2px 的描边像素微调(canvas 填色不需要那层 hairline 补偿)。
function computeBoxUVRects(element) {
	const s0 = element.size(0, 'box_uv');
	const s1 = element.size(1, 'box_uv');
	const s2 = element.size(2, 'box_uv');
	const rects = [];
	if (s1 > 0) {
		rects.push({ left: 0, top: s2, width: s2 * 2 + s0 * 2, height: s1 });
	}
	if (s0 > 0) {
		rects.push({ left: s2, top: 0, width: s0 * 2, height: s2 });
	}
	rects.push({
		left: s2,
		top: s0 > 0 ? 0 : s2,
		width: s0,
		height: (s0 > 0 ? s2 : 0) + s1,
	});
	if (s1 > 0 && s0 > 0) {
		rects.push({ left: s2 * 2 + s0, top: s2, width: s0, height: s1 });
	}
	return rects;
}

function readSelectedFaces(vue, element) {
	// 复刻 UVEditor.getSelectedFaces 逻辑（不建 selection 数组时只读）
	const UVEditor = globalThis.UVEditor;
	if (UVEditor && typeof UVEditor.getSelectedFaces === 'function') {
		return UVEditor.getSelectedFaces(element) || [];
	}
	return [];
}
