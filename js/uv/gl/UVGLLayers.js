// UVEditor GL — 各层几何构造与更新
// Sprint 1: TextureLayer + FaceLayer + OutlineLayer（只覆盖 cube_uv_face 非 box_uv）
// Sprint 2: FaceLayer/OutlineLayer 顺带吃下 box_uv_rects(同为矩形,复用同一套 shader/instancing);
//           新增 MeshFaceLayer + MeshOutlineLayer 画 mesh_uv_face(三角化 fill + 描边)。
//
// 每层暴露: constructor(scene), update(drawState, palette), dispose()
// palette 由 UVGLScene 从 CSS 变量抽取,传入。

import {
	FACE_VERTEX_SHADER,
	FACE_FRAGMENT_SHADER,
	FACE_STATE_COUNT,
} from './UVGLShaders.js';

// -------------------- Texture 底板 --------------------

export class TextureLayer {
	constructor(scene) {
		this.scene = scene;
		this.mesh = null;
		this.texture_ref = null;
	}

	update(drawState) {
		const tex = drawState.texture;
		const w = drawState.inner_width;
		const h = drawState.inner_height;

		if (!tex || !tex.img || !tex.img.tex) {
			if (this.mesh) this.mesh.visible = false;
			return;
		}

		if (!this.mesh || this.texture_ref !== tex) {
			this._replaceMesh(tex);
		}

		this.mesh.scale.set(w, h, 1);
		this.mesh.position.set(w / 2, h / 2, -0.5);
		this.mesh.visible = true;
		tex.img.tex.needsUpdate = true;
	}

	_replaceMesh(tex) {
		this._disposeMesh();
		const geom = new THREE.PlaneGeometry(1, 1);
		// PlaneGeometry 默认 y 向上;我们的相机 y 向下,翻 uv
		const uvs = geom.attributes.uv.array;
		for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
		geom.attributes.uv.needsUpdate = true;

		const mat = new THREE.MeshBasicMaterial({
			map: tex.img.tex,
			transparent: true,
			depthTest: false,
			depthWrite: false,
		});
		this.mesh = new THREE.Mesh(geom, mat);
		this.mesh.frustumCulled = false;
		this.scene.add(this.mesh);
		this.texture_ref = tex;
	}

	_disposeMesh() {
		if (!this.mesh) return;
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.mesh.material.dispose(); // 注意: 不 dispose texture 本身,texture 由 BB Texture 管
		this.mesh = null;
		this.texture_ref = null;
	}

	dispose() {
		this._disposeMesh();
	}
}

// -------------------- cube_uv_face 填色 InstancedMesh --------------------

const INITIAL_INSTANCES = 1024;

export class FaceLayer {
	constructor(scene) {
		this.scene = scene;
		this.maxInstances = INITIAL_INSTANCES;

		const geom = new THREE.InstancedBufferGeometry();
		// 单位 quad(0..1),两三角形 6 顶点
		const positions = new Float32Array([
			0, 0, 0,   1, 0, 0,   1, 1, 0,
			0, 0, 0,   1, 1, 0,   0, 1, 0,
		]);
		geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

		this._allocAttributes(geom, this.maxInstances);
		this.geom = geom;

		const uFillColors = [];
		for (let i = 0; i < FACE_STATE_COUNT; i++) {
			uFillColors.push(new THREE.Vector4(0.5, 0.5, 0.5, 0.0));
		}
		this.material = new THREE.ShaderMaterial({
			vertexShader: FACE_VERTEX_SHADER,
			fragmentShader: FACE_FRAGMENT_SHADER,
			transparent: true,
			depthTest: false,
			depthWrite: false,
			uniforms: { uFillColors: { value: uFillColors } },
		});

		this.mesh = new THREE.Mesh(geom, this.material);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 1;
		scene.add(this.mesh);
		this.count = 0;
	}

	_allocAttributes(geom, cap) {
		const iOffset = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
		const iSize   = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2).setUsage(THREE.DynamicDrawUsage);
		const iState  = new THREE.InstancedBufferAttribute(new Float32Array(cap    ), 1).setUsage(THREE.DynamicDrawUsage);
		const iZ      = new THREE.InstancedBufferAttribute(new Float32Array(cap    ), 1).setUsage(THREE.DynamicDrawUsage);
		geom.setAttribute('iOffset', iOffset);
		geom.setAttribute('iSize',   iSize);
		geom.setAttribute('iState',  iState);
		geom.setAttribute('iZ',      iZ);
		this.iOffset = iOffset;
		this.iSize   = iSize;
		this.iState  = iState;
		this.iZ      = iZ;
	}

	_ensureCapacity(n) {
		if (n <= this.maxInstances) return;
		let cap = this.maxInstances;
		while (cap < n) cap *= 2;
		this.maxInstances = cap;
		this._allocAttributes(this.geom, cap);
	}

	update(drawState, palette) {
		// Sprint 2: box_uv_rects 跟 cube_faces 一样是"轴对齐矩形 + 状态色",直接拼进同一批 instance。
		const faces = (drawState.box_uv_rects && drawState.box_uv_rects.length)
			? drawState.cube_faces.concat(drawState.box_uv_rects)
			: drawState.cube_faces;
		const n = faces.length;
		this._ensureCapacity(n);

		const off = this.iOffset.array;
		const sz  = this.iSize.array;
		const st  = this.iState.array;
		const z   = this.iZ.array;
		for (let i = 0; i < n; i++) {
			const f = faces[i];
			off[i * 2    ] = f.offset[0];
			off[i * 2 + 1] = f.offset[1];
			sz [i * 2    ] = f.size[0];
			sz [i * 2 + 1] = f.size[1];
			st [i]         = f.state;
			z  [i]         = f.state * 0.01;
		}
		this.iOffset.needsUpdate = true;
		this.iSize.needsUpdate = true;
		this.iState.needsUpdate = true;
		this.iZ.needsUpdate = true;
		this.geom.instanceCount = n;
		this.count = n;

		if (palette && palette.fill) {
			const arr = this.material.uniforms.uFillColors.value;
			for (let i = 0; i < FACE_STATE_COUNT; i++) {
				const c = palette.fill[i];
				arr[i].set(c[0], c[1], c[2], c[3]);
			}
		}
	}

	dispose() {
		this.scene.remove(this.mesh);
		this.geom.dispose();
		this.material.dispose();
	}
}

// -------------------- 面描边 LineSegments --------------------
// 每个 face 4 条独立线段 = 8 顶点。line width 固定 1px(WebGL 限制),Sprint 3 若需粗线换 Line2。

export class OutlineLayer {
	constructor(scene) {
		this.scene = scene;
		this.geometry = new THREE.BufferGeometry();
		this.material = new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			depthTest: false,
			depthWrite: false,
		});
		this.lines = new THREE.LineSegments(this.geometry, this.material);
		this.lines.frustumCulled = false;
		this.lines.renderOrder = 2;
		scene.add(this.lines);

		this._positions = new Float32Array(0);
		this._colors    = new Float32Array(0);
		this._capacity  = 0;
	}

	_ensureCapacity(n) {
		// n = face 数;每 face 8 顶点 * 3 = 24 float pos + 24 float color
		// 注意: 还要判断 attribute 是否已创建 —— n==0(常见,比如没有任何面要画)时
		// "n <= capacity" 单独判断会在 capacity 初始值 0 时误判"够用",导致 attribute
		// 从未被 setAttribute 过,后面 `.needsUpdate = true` 就会因为 undefined 报错。
		if (n <= this._capacity && this.geometry.attributes.position) return;
		let cap = Math.max(this._capacity, 512);
		while (cap < n) cap *= 2;
		this._capacity = cap;
		this._positions = new Float32Array(cap * 24);
		this._colors    = new Float32Array(cap * 24);
		this.geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3).setUsage(THREE.DynamicDrawUsage));
		this.geometry.setAttribute('color',    new THREE.BufferAttribute(this._colors,    3).setUsage(THREE.DynamicDrawUsage));
	}

	update(drawState, palette) {
		// Sprint 2: 同 FaceLayer,box_uv_rects 拼进同一批描边线段。
		const faces = (drawState.box_uv_rects && drawState.box_uv_rects.length)
			? drawState.cube_faces.concat(drawState.box_uv_rects)
			: drawState.cube_faces;
		const n = faces.length;
		this._ensureCapacity(n);

		const pos = this._positions;
		const col = this._colors;
		const strokeColors = palette && palette.stroke ? palette.stroke : null;

		for (let i = 0; i < n; i++) {
			const f = faces[i];
			const x0 = f.offset[0];
			const y0 = f.offset[1];
			const x1 = x0 + f.size[0];
			const y1 = y0 + f.size[1];
			const zz = f.state * 0.01 + 0.005;

			const base = i * 24;
			// top edge: (x0,y0) -> (x1,y0)
			pos[base +  0] = x0; pos[base +  1] = y0; pos[base +  2] = zz;
			pos[base +  3] = x1; pos[base +  4] = y0; pos[base +  5] = zz;
			// right edge: (x1,y0) -> (x1,y1)
			pos[base +  6] = x1; pos[base +  7] = y0; pos[base +  8] = zz;
			pos[base +  9] = x1; pos[base + 10] = y1; pos[base + 11] = zz;
			// bottom edge: (x1,y1) -> (x0,y1)
			pos[base + 12] = x1; pos[base + 13] = y1; pos[base + 14] = zz;
			pos[base + 15] = x0; pos[base + 16] = y1; pos[base + 17] = zz;
			// left edge: (x0,y1) -> (x0,y0)
			pos[base + 18] = x0; pos[base + 19] = y1; pos[base + 20] = zz;
			pos[base + 21] = x0; pos[base + 22] = y0; pos[base + 23] = zz;

			const c = strokeColors ? strokeColors[f.state] : [1, 1, 1];
			for (let v = 0; v < 8; v++) {
				col[base + v * 3    ] = c[0];
				col[base + v * 3 + 1] = c[1];
				col[base + v * 3 + 2] = c[2];
			}
		}

		this.geometry.attributes.position.needsUpdate = true;
		this.geometry.attributes.color.needsUpdate = true;
		this.geometry.setDrawRange(0, n * 8);
		this.geometry.computeBoundingSphere();
	}

	dispose() {
		this.scene.remove(this.lines);
		this.geometry.dispose();
		this.material.dispose();
	}
}

// -------------------- mesh_uv_face 填色(按 state 分桶,支持逐状态 alpha) --------------------
// InstancedMesh 不适合变长多边形,这里用"每个 state 一个 Mesh"的分桶方案:
// 同一 state 下 alpha/颜色一致,用统一 material.opacity 即可,不需要为逐顶点 alpha 写自定义 shader。

export class MeshFaceLayer {
	constructor(scene) {
		this.scene = scene;
		this.buckets = new Map(); // state(number) -> {mesh, geometry, material, capacity, positions}
	}

	_ensureBucket(state) {
		let b = this.buckets.get(state);
		if (b) return b;
		const geometry = new THREE.BufferGeometry();
		const material = new THREE.MeshBasicMaterial({
			transparent: true,
			depthTest: false,
			depthWrite: false,
			opacity: 0,
		});
		const mesh = new THREE.Mesh(geometry, material);
		mesh.frustumCulled = false;
		mesh.renderOrder = 1;
		mesh.visible = false;
		this.scene.add(mesh);
		b = { mesh, geometry, material, capacity: 0, positions: new Float32Array(0) };
		this.buckets.set(state, b);
		return b;
	}

	_ensureCapacity(bucket, nVerts) {
		// 同 OutlineLayer._ensureCapacity 的注释: nVerts==0 时不能只看 capacity,还要看
		// attribute 是否已创建,否则新建的桶永远不会 setAttribute,后面 needsUpdate 就会报错。
		if (nVerts <= bucket.capacity && bucket.geometry.attributes.position) return;
		let cap = Math.max(bucket.capacity, 768);
		while (cap < nVerts) cap *= 2;
		bucket.capacity = cap;
		bucket.positions = new Float32Array(cap * 3);
		bucket.geometry.setAttribute('position', new THREE.BufferAttribute(bucket.positions, 3).setUsage(THREE.DynamicDrawUsage));
	}

	update(drawState, palette) {
		const faces = drawState.mesh_faces || [];
		const byState = new Map(); // state -> flat [x,y] triangle points
		for (const f of faces) {
			let arr = byState.get(f.state);
			if (!arr) { arr = []; byState.set(f.state, arr); }
			for (const p of f.triangles) arr.push(p);
		}

		const fillColors = palette && palette.fill ? palette.fill : null;

		for (const [state, points] of byState) {
			const bucket = this._ensureBucket(state);
			const n = points.length;
			this._ensureCapacity(bucket, n);
			const pos = bucket.positions;
			const zz = state * 0.01;
			for (let i = 0; i < n; i++) {
				const p = points[i];
				pos[i * 3    ] = p[0];
				pos[i * 3 + 1] = p[1];
				pos[i * 3 + 2] = zz;
			}
			bucket.geometry.attributes.position.needsUpdate = true;
			bucket.geometry.setDrawRange(0, n);
			bucket.geometry.computeBoundingSphere();
			const c = fillColors ? fillColors[state] : [1, 1, 1, 0];
			bucket.material.color.setRGB(c[0], c[1], c[2]);
			bucket.material.opacity = c[3];
			bucket.mesh.visible = n > 0 && c[3] > 0.001;
		}
		// 这一帧没出现的 state 桶隐藏,避免残留上一帧的三角形
		for (const [state, bucket] of this.buckets) {
			if (!byState.has(state)) bucket.mesh.visible = false;
		}
	}

	dispose() {
		for (const bucket of this.buckets.values()) {
			this.scene.remove(bucket.mesh);
			bucket.geometry.dispose();
			bucket.material.dispose();
		}
		this.buckets.clear();
	}
}

// -------------------- mesh_uv_face 描边 LineSegments --------------------
// 每个 face 是变长多边形(polygon.length 条边),不能像 cube OutlineLayer 那样固定 8 顶点/face,
// 这里按"总顶点数"动态扩容,逐顶点烘焙颜色(描边不透明,不需要逐状态 alpha,直接复用 palette.stroke)。

export class MeshOutlineLayer {
	constructor(scene) {
		this.scene = scene;
		this.geometry = new THREE.BufferGeometry();
		this.material = new THREE.LineBasicMaterial({
			vertexColors: true,
			transparent: true,
			depthTest: false,
			depthWrite: false,
		});
		this.lines = new THREE.LineSegments(this.geometry, this.material);
		this.lines.frustumCulled = false;
		this.lines.renderOrder = 2;
		this.scene.add(this.lines);

		this._positions = new Float32Array(0);
		this._colors = new Float32Array(0);
		this._capacity = 0; // 顶点数(每条边占 2 个顶点)
	}

	_ensureCapacity(nVerts) {
		// 同 OutlineLayer 的注释: mesh_faces 为空(没有 mesh 元素是最常见的情况)时 nVerts==0,
		// 不能只看 capacity,还要看 attribute 是否已创建,否则永远不会 setAttribute。
		if (nVerts <= this._capacity && this.geometry.attributes.position) return;
		let cap = Math.max(this._capacity, 1024);
		while (cap < nVerts) cap *= 2;
		this._capacity = cap;
		this._positions = new Float32Array(cap * 3);
		this._colors    = new Float32Array(cap * 3);
		this.geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3).setUsage(THREE.DynamicDrawUsage));
		this.geometry.setAttribute('color',    new THREE.BufferAttribute(this._colors,    3).setUsage(THREE.DynamicDrawUsage));
	}

	update(drawState, palette) {
		const faces = drawState.mesh_faces || [];
		let totalVerts = 0;
		for (const f of faces) totalVerts += f.polygon.length * 2;
		this._ensureCapacity(totalVerts);

		const pos = this._positions;
		const col = this._colors;
		const strokeColors = palette && palette.stroke ? palette.stroke : null;
		let vi = 0;
		for (const f of faces) {
			const poly = f.polygon;
			const n = poly.length;
			if (n < 2) continue;
			const zz = f.state * 0.01 + 0.005;
			const c = strokeColors ? strokeColors[f.state] : [1, 1, 1];
			for (let i = 0; i < n; i++) {
				const a = poly[i];
				const b = poly[(i + 1) % n];
				const base = vi * 3;
				pos[base] = a[0]; pos[base + 1] = a[1]; pos[base + 2] = zz;
				col[base] = c[0]; col[base + 1] = c[1]; col[base + 2] = c[2];
				vi++;
				const base2 = vi * 3;
				pos[base2] = b[0]; pos[base2 + 1] = b[1]; pos[base2 + 2] = zz;
				col[base2] = c[0]; col[base2 + 1] = c[1]; col[base2 + 2] = c[2];
				vi++;
			}
		}
		this.geometry.attributes.position.needsUpdate = true;
		this.geometry.attributes.color.needsUpdate = true;
		this.geometry.setDrawRange(0, vi);
		this.geometry.computeBoundingSphere();
	}

	dispose() {
		this.scene.remove(this.lines);
		this.geometry.dispose();
		this.material.dispose();
	}
}

// -------------------- Sprint 3: 纯视觉 overlay(框选矩形 + 对齐辅助线) --------------------
// 两者都是 pointer-events:none,自己没有交互,数量恒定(O(1)),用普通 Mesh/LineSegments 就够,
// 不需要 instancing。resize/rotate 手柄、mesh 顶点手柄、#uv_selection_frame 整体缩放/旋转框、
// 文字 label 仍是 DOM(Sprint 3 后续再迁,详见 uv.js 里对应方法的注释)。

export class OverlayLayer {
	constructor(scene) {
		this.scene = scene;

		// 框选矩形: 半透明填色 + 实线描边,对应原 .selection_rectangle(css/general.css)
		const quadPositions = new Float32Array([
			0, 0, 0,   1, 0, 0,   1, 1, 0,
			0, 0, 0,   1, 1, 0,   0, 1, 0,
		]);
		const rectGeom = new THREE.BufferGeometry();
		rectGeom.setAttribute('position', new THREE.BufferAttribute(quadPositions, 3));
		this.rectMaterial = new THREE.MeshBasicMaterial({
			color: 0x28323c, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false,
		});
		this.rectMesh = new THREE.Mesh(rectGeom, this.rectMaterial);
		this.rectMesh.frustumCulled = false;
		this.rectMesh.renderOrder = 8; // 对应原 CSS #uv_frame .selection_rectangle { z-index: 8 }
		this.rectMesh.visible = false;
		scene.add(this.rectMesh);

		const rectOutlineGeom = new THREE.BufferGeometry();
		rectOutlineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3).setUsage(THREE.DynamicDrawUsage));
		this.rectOutlineMaterial = new THREE.LineBasicMaterial({
			color: 0x3399ff, transparent: true, depthTest: false, depthWrite: false,
		});
		this.rectOutline = new THREE.LineSegments(rectOutlineGeom, this.rectOutlineMaterial);
		this.rectOutline.frustumCulled = false;
		this.rectOutline.renderOrder = 8;
		this.rectOutline.visible = false;
		scene.add(this.rectOutline);

		// 对齐辅助线: 一条竖线(x) + 一条横线(y),对应 .uv_helper_line_x / .uv_helper_line_y
		const helperGeom = new THREE.BufferGeometry();
		helperGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
		this.helperMaterial = new THREE.LineBasicMaterial({
			color: 0x3399ff, transparent: true, depthTest: false, depthWrite: false,
		});
		this.helperLines = new THREE.LineSegments(helperGeom, this.helperMaterial);
		this.helperLines.frustumCulled = false;
		this.helperLines.renderOrder = 6;
		this.helperLines.visible = false;
		scene.add(this.helperLines);
	}

	update(drawState, palette) {
		this._updateSelectionRect(drawState);
		this._updateHelperLines(drawState);
		if (palette && palette.stroke) {
			// 复用 SELECTED_PRIMARY(accent 色)当框选矩形描边 / 辅助线颜色,跟原 CSS 的 --color-accent 对应。
			const c = palette.stroke[4];
			this.rectOutlineMaterial.color.setRGB(c[0], c[1], c[2]);
			this.helperMaterial.color.setRGB(c[0], c[1], c[2]);
		}
	}

	_updateSelectionRect(drawState) {
		const rect = drawState.selection_rect;
		if (!rect || !rect.active || rect.width <= 0 || rect.height <= 0) {
			this.rectMesh.visible = false;
			this.rectOutline.visible = false;
			return;
		}
		this.rectMesh.visible = true;
		this.rectMesh.scale.set(rect.width, rect.height, 1);
		this.rectMesh.position.set(rect.x, rect.y, 0.5);

		const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.width, y1 = rect.y + rect.height, z = 0.51;
		const pos = this.rectOutline.geometry.attributes.position.array;
		pos[0] = x0; pos[1] = y0; pos[2] = z;   pos[3] = x1; pos[4] = y0; pos[5] = z;
		pos[6] = x1; pos[7] = y0; pos[8] = z;   pos[9] = x1; pos[10] = y1; pos[11] = z;
		pos[12] = x1; pos[13] = y1; pos[14] = z; pos[15] = x0; pos[16] = y1; pos[17] = z;
		pos[18] = x0; pos[19] = y1; pos[20] = z; pos[21] = x0; pos[22] = y0; pos[23] = z;
		this.rectOutline.geometry.attributes.position.needsUpdate = true;
		this.rectOutline.geometry.computeBoundingSphere();
		this.rectOutline.visible = true;
	}

	_updateHelperLines(drawState) {
		const hl = drawState.helper_lines;
		const hx = hl ? hl.x : -1;
		const hy = hl ? hl.y : -1;
		const w = drawState.inner_width || 0;
		const h = drawState.inner_height || 0;
		const z = 0.3;
		const pos = this.helperLines.geometry.attributes.position.array;

		if (hx >= 0) {
			pos[0] = hx; pos[1] = 0; pos[2] = z;
			pos[3] = hx; pos[4] = h; pos[5] = z;
		} else {
			pos[0] = 0; pos[1] = 0; pos[2] = z;
			pos[3] = 0; pos[4] = 0; pos[5] = z;
		}
		if (hy >= 0) {
			pos[6] = 0; pos[7] = hy; pos[8] = z;
			pos[9] = w; pos[10] = hy; pos[11] = z;
		} else {
			pos[6] = 0; pos[7] = 0; pos[8] = z;
			pos[9] = 0; pos[10] = 0; pos[11] = z;
		}
		this.helperLines.geometry.attributes.position.needsUpdate = true;
		this.helperLines.geometry.computeBoundingSphere();
		this.helperLines.visible = (hx >= 0 || hy >= 0);
	}

	dispose() {
		this.scene.remove(this.rectMesh);
		this.rectMesh.geometry.dispose();
		this.rectMaterial.dispose();
		this.scene.remove(this.rectOutline);
		this.rectOutline.geometry.dispose();
		this.rectOutlineMaterial.dispose();
		this.scene.remove(this.helperLines);
		this.helperLines.geometry.dispose();
		this.helperMaterial.dispose();
	}
}
