import { THREE } from '../lib/libs';
import { Setting, settings } from '../interface/settings';
import { PointerTarget } from '../interface/pointer_target';

// [Behemiron] 视角巡航渲染(Orbit Cruise Render)——大模型导航期临时合并优化。
//
// 背景:参考了第三方插件 "Multi Cube Mesh Optimizer" 的思路(把很多个 cube
// 合并成少数几个 mesh + 剔除贴合内表面 + 拾取系统)。Phase 1 一开始只在相机
// 拖拽这几百毫秒内生效,松手立刻切回原生逐 cube 渲染,不需要碰拾取系统。
// Phase 2 把"合并视图"从"仅拖拽期间"扩展成"静止查看态也常驻",做法:
//
//   1. **不再单独监听 OrbitControls 的 start/end 事件**——已确认
//      `js/interface/pointer_target.ts` 的 `PointerTarget` 是一个更通用、
//      已经被相机拖拽(OrbitControls.js:610 `requestTarget(types.navigate)`)、
//      变换 gizmo 拖拽(transform_gizmo.js:1358 `requestTarget(types.
//      gizmo_transform)`)、取色笔刷等**所有**"当前谁占用了指针"场景共用的
//      中心化信号——`PointerTarget.active` 非空就说明有正在进行的拖拽/编辑
//      操作。改成每帧(在 Preview.render() 里)轮询一次
//      `shouldBeCruisingNow()`,状态真正翻转时才触发一次
//      enable/disableCruiseRender(),比"分别监听好几种拖拽事件"更简单也更
//      不容易漏掉某个交互路径。
//   2. **不移植自定义空间索引拾取**——已确认 `THREE.Mesh.raycast()`
//      本身不检查 `.visible`(纯几何计算),`js/preview/preview.js:430-432`
//      对 `mesh.visible==false` 的过滤只发生在"收集候选对象"这一步,在
//      `preview.js` 的 `raycast()` 方法里新增一个兜底分支:原生候选列表
//      (只含可见 mesh)没命中、且巡航渲染当前生效时,直接对"被巡航渲染隐藏
//      的真实 cube mesh"们重新跑一次 `this.raycaster.intersectObjects(...)`
//      ——复用 THREE 自己的光线检测,拿到的是货真价实、face/uv/point 都正确
//      的交点数据,下游选中/材质拾色等逻辑完全不用改一行。这比另起一套
//      自定义包围盒空间索引风险低得多,只是把"一次性、按需触发"的拾取计算
//      成本从"厂商已经优化好的 raycaster"里多算一次而已(不是每帧都算,只
//      在用户真的点击/移动鼠标时才算)。
//   3. **有选中内容时不进入常驻巡航**——选中某个 cube 后,原生的选中高亮/
//      gizmo 是画在真实 mesh 上的,巡航视图不区分选中态,常驻合并会让"选中
//      了什么"完全不可见。所以 `shouldBeCruisingNow()` 额外要求
//      `Outliner.selected` 为空——纯浏览模型(没有选中任何东西)时才享受
//      常驻巡航渲染的性能收益,一旦选中/正在拖拽,立刻退回原生逐 cube 渲染,
//      选中反馈/编辑实时预览完全不受影响。

const SETTING_ID = 'orbit_cruise_render';
const CUBE_COUNT_THRESHOLD = 500;

interface HiddenOriginal {
	mesh: any;
	was_visible: boolean;
}

interface TriangleVertex {
	p: any; // THREE.Vector3
	n: any | null; // THREE.Vector3 | null
	uv: [number, number] | null;
}

interface Triangle {
	key: string;
	material: any;
	vertices: [TriangleVertex, TriangleVertex, TriangleVertex];
	normal: any | null; // THREE.Vector3 | null
}

// 合并/剔除结果的缓存。cache_dirty 由 finish_edit 触发,拖拽开始时如果发现
// 缓存脏了才重新构建——不在每次编辑后立刻重建,重建本身有成本,等到真正
// 要用(下一次拖拽)才做。
let cached_meshes: any[] | null = null;
let cache_dirty = true;
let hidden_originals: HiddenOriginal[] = [];

function isSettingEnabled(): boolean {
	let setting = settings[SETTING_ID];
	return !!(setting && setting.value);
}

function getCubeCount(): number {
	return (typeof Cube !== 'undefined' && Array.isArray(Cube.all)) ? Cube.all.length : 0;
}

// 门控:开关已开 + cube 数超过阈值 + 不在会改写渲染语义的模式下。
// 参考插件在这几个模式下一律关闭优化(paint 需要看到真实材质细节、animate/
// display 有自己的独立渲染路径),这里直接照搬同样的判断。
export function shouldCruiseRender(): boolean {
	if (!isSettingEnabled()) return false;
	if (typeof Modes === 'undefined') return false;
	if (Modes.paint || Modes.animate || Modes.display) return false;
	if (getCubeCount() < CUBE_COUNT_THRESHOLD) return false;
	return true;
}

// 是否有任何交互正占用指针(相机拖拽/变换 gizmo 拖拽/取色笔刷/UI 滑杆拖拽,
// 见 js/interface/pointer_target.ts 的 PointerTarget——这是本仓库已有的
// 中心化"谁占用了指针"信号,不需要分别监听每种工具各自的 mousedown)。
function isPointerInteractionActive(): boolean {
	return !!(typeof PointerTarget !== 'undefined' && PointerTarget.active);
}

// 是否有任何选中内容——选中态的高亮/gizmo 画在真实 mesh 上,巡航视图不
// 区分选中态,有选中内容时常驻合并会让选中反馈完全不可见,所以只在"纯浏览、
// 什么都没选中"时才允许常驻。
function hasAnySelection(): boolean {
	return !!(typeof Outliner !== 'undefined' && Array.isArray(Outliner.selected) && Outliner.selected.length > 0);
}

// 综合门控:这一刻是否应该显示巡航合并视图(而不是原生逐 cube 渲染)。
// 每帧轮询,只有状态真正翻转时调用方(tickOrbitCruiseRender)才会触发一次
// enable/disableCruiseRender,不会因为轮询本身产生额外开销。
function shouldBeCruisingNow(): boolean {
	if (!shouldCruiseRender()) return false;
	if (isPointerInteractionActive()) return false;
	if (hasAnySelection()) return false;
	return true;
}

export function markCruiseRenderCacheDirty(): void {
	cache_dirty = true;
}

function isCubeEffectivelyVisible(cube: any): boolean {
	if (!cube || cube.visibility === false) return false;
	let parent = cube.parent;
	let guard = 0;
	while (parent && guard++ < 64) {
		if (parent.visibility === false) return false;
		if (!parent.children) break; // 到根节点(不是 Group)就停
		parent = parent.parent;
	}
	return true;
}

function getCubesForCruiseRender(): any[] {
	if (typeof Cube === 'undefined' || !Array.isArray(Cube.all)) return [];
	return Cube.all.filter(cube => cube && cube.mesh && cube.mesh.geometry && isCubeEffectivelyVisible(cube));
}

// 量化坐标,避免 1.0000000002 这种浮点误差导致贴合面匹配不上。
function qn(n: number): number {
	return Math.round(n * 1e5) / 1e5;
}

function vertexKey(v: any): string {
	return qn(v.x) + ',' + qn(v.y) + ',' + qn(v.z);
}

function triangleKey(a: any, b: any, c: any): string {
	return [vertexKey(a), vertexKey(b), vertexKey(c)].sort().join('|');
}

function getMaterialKey(material: any): string {
	return (material && material.uuid) || 'null';
}

function readTransformedVertex(geometry: any, vertexIndex: number, matrixWorld: any, normalMatrix: any): TriangleVertex {
	let pos = geometry.attributes.position;
	let normal = geometry.attributes.normal;
	let uv = geometry.attributes.uv;
	let v = new THREE.Vector3(pos.getX(vertexIndex), pos.getY(vertexIndex), pos.getZ(vertexIndex));
	v.applyMatrix4(matrixWorld);
	let n = null;
	if (normal) {
		n = new THREE.Vector3(normal.getX(vertexIndex), normal.getY(vertexIndex), normal.getZ(vertexIndex));
		n.applyMatrix3(normalMatrix).normalize();
	}
	return {
		p: v,
		n,
		uv: uv ? [uv.getX(vertexIndex), uv.getY(vertexIndex)] : null,
	};
}

function getTriangleCullNormal(a: TriangleVertex, b: TriangleVertex, c: TriangleVertex): any | null {
	if (a.n && b.n && c.n) {
		let normal = new THREE.Vector3(a.n.x + b.n.x + c.n.x, a.n.y + b.n.y + c.n.y, a.n.z + b.n.z + c.n.z);
		if (normal.lengthSq() > 1e-10) return normal.normalize();
	}
	let ab = new THREE.Vector3().subVectors(b.p, a.p);
	let ac = new THREE.Vector3().subVectors(c.p, a.p);
	let normal = ab.cross(ac);
	return normal.lengthSq() > 1e-10 ? normal.normalize() : null;
}

function areTriangleNormalsOpposite(a: any, b: any): boolean {
	return !!(a && b && a.dot(b) < -0.9);
}

function areTriangleNormalsSame(a: any, b: any): boolean {
	if (!a || !b) return !a && !b;
	return a.dot(b) > 0.9;
}

// 核心剔除算法:按世界坐标位置指纹分组三角形——同一个指纹下,法线相反的
// 一对互为两个 cube 贴合处彼此背对的内表面,整组剔除;法线相同的是重复
// 重叠面,只保留一个。移植自参考插件的 findCulledTriangleSet,纯几何计算,
// 不依赖插件自己的框架代码。
function findCulledTriangleSet(triangles: Triangle[], triangle_groups: Map<string, number[]>): Set<number> {
	let culled = new Set<number>();
	triangle_groups.forEach(indices => {
		if (indices.length < 2) return;
		for (let i = 0; i < indices.length; i++) {
			let a = triangles[indices[i]];
			for (let j = i + 1; j < indices.length; j++) {
				let b = triangles[indices[j]];
				if (areTriangleNormalsOpposite(a.normal, b.normal)) {
					culled.add(indices[i]);
					culled.add(indices[j]);
					return;
				}
			}
		}
		let kept: number[] = [];
		indices.forEach(index => {
			let tri = triangles[index];
			if (kept.some(kept_index => areTriangleNormalsSame(tri.normal, triangles[kept_index].normal))) {
				culled.add(index);
			} else {
				kept.push(index);
			}
		});
	});
	return culled;
}

interface Bucket {
	material: any;
	positions: number[];
	normals: number[];
	uvs: number[];
}

function pushTriangleToBucket(bucket: Bucket, tri: Triangle): void {
	for (let i = 0; i < 3; i++) {
		let v = tri.vertices[i];
		bucket.positions.push(v.p.x, v.p.y, v.p.z);
		if (v.n) bucket.normals.push(v.n.x, v.n.y, v.n.z);
		if (v.uv) bucket.uvs.push(v.uv[0], v.uv[1]);
	}
}

// 遍历所有可见 cube 的三角形,剔除贴合内表面后按材质分桶,每个材质桶各构造
// 一个 BufferGeometry + Mesh。这些 mesh 故意不放进 Outliner.elements,
// js/preview/preview.js:430 的拾取遍历天然看不到它们——不需要额外调用任何
// "禁用 raycast" 的代码。
function buildCruiseMeshes(): any[] {
	let cubes = getCubesForCruiseRender();
	let triangles: Triangle[] = [];
	let triangle_groups = new Map<string, number[]>();

	cubes.forEach(cube => {
		let mesh = cube.mesh;
		let geometry = mesh.geometry;
		if (!geometry || !geometry.attributes || !geometry.attributes.position) return;

		let materialSource = mesh.material;
		let materials = Array.isArray(materialSource) ? materialSource : [materialSource];
		if (!materials.length || !materials[0]) return;

		mesh.updateMatrixWorld(true);
		let matrixWorld = mesh.matrixWorld;
		let normalMatrix = new THREE.Matrix3().getNormalMatrix(matrixWorld);

		let index = geometry.index;
		let groups = (geometry.groups && geometry.groups.length)
			? geometry.groups
			: [{ start: 0, count: index ? index.count : geometry.attributes.position.count, materialIndex: 0 }];

		groups.forEach((group: any) => {
			let material = materials[group.materialIndex || 0] || materials[0];
			if (!material) return;
			let start = group.start || 0;
			let count = group.count || 0;
			let end = start + count;

			// 按三角形读取。cube 的每个面都是两个三角形(见 cube.js updateFaces 的 indices 构造)。
			for (let i = start; i + 2 < end; i += 3) {
				let ia = index ? index.getX(i) : i;
				let ib = index ? index.getX(i + 1) : i + 1;
				let ic = index ? index.getX(i + 2) : i + 2;
				let a = readTransformedVertex(geometry, ia, matrixWorld, normalMatrix);
				let b = readTransformedVertex(geometry, ib, matrixWorld, normalMatrix);
				let c = readTransformedVertex(geometry, ic, matrixWorld, normalMatrix);
				let key = triangleKey(a.p, b.p, c.p);
				let tri: Triangle = { key, material, vertices: [a, b, c], normal: getTriangleCullNormal(a, b, c) };
				let tri_index = triangles.length;
				triangles.push(tri);
				if (!triangle_groups.has(key)) triangle_groups.set(key, []);
				triangle_groups.get(key)!.push(tri_index);
			}
		});
	});

	let culled = findCulledTriangleSet(triangles, triangle_groups);
	let buckets = new Map<string, Bucket>();
	triangles.forEach((tri, index) => {
		if (culled.has(index)) return;
		let key = getMaterialKey(tri.material);
		if (!buckets.has(key)) buckets.set(key, { material: tri.material, positions: [], normals: [], uvs: [] });
		pushTriangleToBucket(buckets.get(key)!, tri);
	});

	let meshes: any[] = [];
	buckets.forEach(bucket => {
		if (!bucket.positions.length) return;
		let geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
		if (bucket.normals.length === bucket.positions.length) {
			geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
		} else {
			geo.computeVertexNormals();
		}
		if (bucket.uvs.length === (bucket.positions.length / 3) * 2) {
			geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
		}
		geo.computeBoundingBox();
		geo.computeBoundingSphere();

		let mesh = new THREE.Mesh(geo, bucket.material);
		mesh.name = 'Behemiron Orbit Cruise Mesh';
		mesh.matrixAutoUpdate = false;
		mesh.frustumCulled = false;
		mesh.userData.behemiron_cruise_proxy = true;
		meshes.push(mesh);
	});
	return meshes;
}

function disposeCruiseMeshes(meshes: any[] | null): void {
	if (!meshes) return;
	meshes.forEach(mesh => {
		if (mesh.parent) mesh.parent.remove(mesh);
		if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
		// material 引用来自 cube.mesh.material,是 BB 自己管理的共享材质,不由这里释放
	});
}

function ensureCruiseMeshesBuilt(): any[] {
	if (cached_meshes && !cache_dirty) return cached_meshes;
	disposeCruiseMeshes(cached_meshes);
	cached_meshes = buildCruiseMeshes();
	cache_dirty = false;
	return cached_meshes;
}

function enableCruiseRender(): void {
	if (typeof Canvas === 'undefined' || !Canvas.scene) return;
	let meshes = ensureCruiseMeshesBuilt();
	meshes.forEach(mesh => {
		if (mesh.parent !== Canvas.scene) Canvas.scene.add(mesh);
	});

	hidden_originals = [];
	getCubesForCruiseRender().forEach(cube => {
		let mesh = cube.mesh;
		hidden_originals.push({ mesh, was_visible: mesh.visible });
		mesh.visible = false;
	});
}

function disableCruiseRender(): void {
	hidden_originals.forEach(entry => {
		entry.mesh.visible = entry.was_visible;
	});
	hidden_originals = [];
	if (cached_meshes) {
		cached_meshes.forEach(mesh => {
			if (mesh.parent) mesh.parent.remove(mesh);
		});
	}
}

let currently_cruising = false;

// 每帧调用一次(挂在 Preview.prototype.render() 里,每个 Preview 实例——
// 主预览/分屏格子/弹出预览窗口——各自的渲染循环都会调,重复调用是安全的
// 空操作,因为只在状态真正翻转时才会触发 enable/disableCruiseRender)。
export function tickOrbitCruiseRender(): void {
	let want = shouldBeCruisingNow();
	if (want === currently_cruising) return;
	currently_cruising = want;
	if (want) {
		enableCruiseRender();
	} else if (hidden_originals.length) {
		disableCruiseRender();
	}
}

// 拾取兜底:js/preview/preview.js 的 raycast() 方法在原生候选列表(只含
// mesh.visible!=false 的对象)没命中、且巡航渲染当前生效时调用这个函数,
// 直接对"被巡航渲染隐藏的真实 cube mesh"重新跑一次 raycaster.intersectObjects
// ——THREE.Mesh.raycast() 本身不检查 visible,拿到的交点数据(face/uv/point)
// 跟原生点击完全一样,下游选中/材质拾色逻辑不需要任何改动。
export function raycastCruiseHiddenCubes(raycaster: any): any[] {
	if (!currently_cruising) return [];
	let cubes = getCubesForCruiseRender();
	if (!cubes.length) return [];
	let objects = cubes.map(cube => cube.mesh);
	return raycaster.intersectObjects(objects, false);
}

let initialized = false;

export function initOrbitCruiseRender(): void {
	if (initialized) return;
	initialized = true;

	new Setting(SETTING_ID, {
		category: 'preview',
		value: false,
		name: tl('settings.' + SETTING_ID),
		description: tl('settings.' + SETTING_ID + '.desc'),
	});

	if (typeof Blockbench !== 'undefined' && Blockbench.on) {
		// finish_edit 覆盖几乎所有编辑操作的完成点(增删/移动/缩放/旋转 cube
		// 都会以 Undo.finishEdit() 收尾)——用它做缓存失效信号,不需要单独
		// 挂 outliner 的 setup/remove 事件。
		Blockbench.on('finish_edit', markCruiseRenderCacheDirty);
	}
}
