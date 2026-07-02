import { ModelProject } from './project';
import { Group } from '../outliner/types/group';
import { Outliner } from '../outliner/outliner';
import { Texture } from '../texturing/textures';
import { Animation } from '../animations/animation';
import { Canvas } from '../preview/canvas';
import { OutlinerElement } from '../outliner/abstract/outliner_element';
import { TickUpdates } from '../misc';

// `Project` 是 project.ts 里用 Object.defineProperty(window, 'Project', ...) 建立的
// 真实运行时全局(等价于 Blockbench.Project 的只读视图)，不是这个模块的具名导出，
// 这里用局部 ambient 声明满足类型检查，不产生任何运行时代码。
declare const Project: any;
declare const window: any;

// Spike B 原型："原地替换已存在 ModelProject 内容"，用于验证跨窗口实时同步
// 是否可以避免 Codecs.project.load()（"从零构造"语义）带来的 ModelProject.all
// 堆积和 Three.js 资源泄漏。详见 behemiron-blockbench-cross-window-sync 方案。
//
// 范围说明（Spike 阶段有意收窄，不影响本次"是否泄漏"核心验证目标）：
// 已覆盖 elements / groups / outliner / textures / animations + 基础选中态。
// 暂不处理 animation_controllers / collections / display / reference_images /
// export_options / history —— Phase 0 正式实现时按需补全。
export function replaceProjectContentInPlace(model: any): boolean {
	const target = ModelProject.all.find((p: any) => p.uuid === (model.behemiron_uuid || model.uuid));
	if (!target) return false; // 目标工程不存在，调用方应回退到 Codecs.project.load()

	const previously_selected = Project;
	target.select();

	// ---- 1. 清空现有内容 ----
	// 复用各类型自身的 remove()，它们是 BB 日常"删除"操作走的同一条路径，
	// 已经处理好 Three.js dispose / Outliner 摘除，不需要重新手写 dispose 逻辑。
	Group.all.filter((g: any) => !(g.parent instanceof Group)).slice().forEach((g: any) => g.remove(false));
	Outliner.elements.filter((el: any) => !(el.parent instanceof Group)).slice().forEach((el: any) => el.remove(false));
	Texture.all.slice().forEach((tex: any) => tex.remove(true));
	Animation.all.slice().forEach((ani: any) => ani.remove(false, false));

	// ---- 2. 按 bbmodel.js parse() 的同等逻辑重新灌入 ----
	if (model.textures) {
		model.textures.forEach((tex: any) => {
			const tex_copy = new (Texture as any)(tex, tex.uuid).add(false);
			if (tex.source && tex.source.substr(0, 5) === 'data:') {
				tex_copy.fromDataURL(tex.source);
			}
		});
	}
	if (model.elements) {
		const default_texture = (Texture as any).getDefault();
		model.elements.forEach((template: any) => {
			const copy: any = (OutlinerElement as any).fromSave(template, true);
			for (const face in copy.faces) {
				if (!Project.format.single_texture && template.faces) {
					const texture = template.faces[face].texture !== null && Texture.all[template.faces[face].texture];
					if (texture) copy.faces[face].texture = texture.uuid;
				} else if (default_texture && copy.faces && copy.faces[face].texture !== null && !Project.format.single_texture_default) {
					copy.faces[face].texture = default_texture.uuid;
				}
			}
			copy.init();
		});
	}
	if (model.groups) {
		model.groups.forEach((template: any) => new (Group as any)(template, template.uuid).init());
	}
	if (model.outliner) {
		(Outliner as any).loadJSON(model.outliner);
	}
	if (model.animations) {
		model.animations.forEach((ani: any) => {
			const base_ani: any = new (Animation as any)();
			base_ani.uuid = ani.uuid;
			base_ani.extend(ani).add();
		});
	}

	(Canvas as any).updateAllBones();
	(Canvas as any).updateAllPositions();
	(Canvas as any).updateAllFaces();

	// ---- 3. 选中态（轻量版，不含相机/mode/tool，Phase 0 补全完整 editor_state） ----
	if (model.editor_state) {
		const state = model.editor_state;
		Project.selected_elements = [];
		(state.selected_elements || []).forEach((uuid: string) => {
			const el = Outliner.elements.find((el2: any) => el2.uuid === uuid);
			if (el) Project.selected_elements.push(el);
		});
		if (state.selected_groups) {
			Group.multi_selected = state.selected_groups
				.map((uuid: string) => Group.all.find((g: any) => g.uuid === uuid))
				.filter((g: any) => g instanceof Group);
		}
		// 只改 Project.selected_elements/Group.multi_selected 这两个原始数据
		// 不会自动反映到界面——大纲树高亮、3D 视口选中框、元素属性面板等都是
		// 由 updateSelection()(misc.js)统一驱动的。跟 BB 自己"删除"/"复制"等
		// 操作改完选中态后的收尾方式一致:标记 TickUpdates.selection,交给下一次
		// animate() 里的 TickUpdates.Run() 触发 updateSelection(),而不是在这里
		// 同步直接调用(此时相关 DOM/Three.js 节点可能还没跟上前面刚灌入的数据)。
		TickUpdates.selection = true;
	}

	// 恢复调用前的活动工程，避免"应用同步"意外切走用户当前正在看的标签。
	if (previously_selected && previously_selected !== target && ModelProject.all.includes(previously_selected)) {
		previously_selected.select();
	}

	return true;
}

// 轻量选中态同步：只改 Project.selected_elements / Group.multi_selected 这两个
// 引用 + 触发 updateSelection() 收尾，完全不碰 Outliner/Texture/Group/Animation
// 的增删（不走 replaceProjectContentInPlace 那套"清空重灌"）。
//
// Why 需要单独一条通道：选中态变化(点大纲树节点/3D 视口点选)如果也走
// replaceProjectContentInPlace，相当于为了"换一下选中"付出整份工程重新
// compile + 全部元素 dispose/reconstruct 的代价——实测这个开销会让选中操作
// 感觉迟钝且有肉眼可见的闪烁(重建期间 Outliner/3D 视口有一瞬间是空的)。
// 选中态本身只是"哪几个 uuid 被选中"，双方工程结构没变时，原地对号入座就够了。
export function applySelectionOnly(elementUuids: string[], groupUuids: string[]): boolean {
	if (!Project) return false;
	Project.selected_elements = Outliner.elements.filter((el: any) => elementUuids.includes(el.uuid));
	Group.multi_selected = Group.all.filter((g: any) => groupUuids.includes(g.uuid));
	TickUpdates.selection = true;
	return true;
}

// 暴露给 behemiron-host.js 用（它是纯 JS、不走 ES import，只能通过 window
// 访问）。命名空间化，避免污染全局作用域。
window.__behemironProjectSync = { replaceProjectContentInPlace, applySelectionOnly };

// ---- 压测入口（仅 Spike 阶段使用，供 devtools console 手动调用）----
// 用法：await window.__spikeSyncStress(10)
//
// 改成异步 + 每次迭代之间让出一帧（setTimeout(0)），原因：
// 第一版是纯同步 for 循环，50 次连续调用把 Outliner.loadJSON()（大纲树重建，
// 触发 Vue 响应式重渲染）+ Codecs.project.compile({bitmaps:true})（整工程重新
// 序列化）全部压在同一个调用栈里，导致主线程长时间不让出，表现为页面"卡死"。
// 让出一帧不会改变"是否泄漏"这个核心结论，但能避免卡死浏览器/方便观察每次
// 迭代的真实耗时（是否随次数递增——递增说明有未清理的响应式监听器等累积问题，
// 持平说明只是单次开销偏高，不是累积性 bug）。
window.__spikeSyncStress = async function (iterations = 10) {
	const snapshotState = () => ({
		projects: ModelProject.all.length,
		geometries: window.main_preview?.renderer?.info?.memory?.geometries ?? -1,
	});
	const before = snapshotState();
	console.info('[spike] before', before);

	const timings: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		const snapshot = window.Codecs.project.compile({ editor_state: true, uuids: true, bitmaps: true, raw: true });
		snapshot.behemiron_uuid = window.Project.uuid;
		replaceProjectContentInPlace(snapshot);
		const elapsed = performance.now() - t0;
		timings.push(elapsed);
		console.info(`[spike] iter ${i + 1}/${iterations} took ${elapsed.toFixed(1)}ms`, snapshotState());
		// 让出一帧，避免长时间阻塞主线程；同时给浏览器机会真正把上一次的
		// dispose/GC 落地，让 geometries 计数更真实。
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	const after = snapshotState();
	console.info('[spike] after', after, 'delta', {
		projects: after.projects - before.projects,
		geometries: after.geometries - before.geometries,
	});
	console.info('[spike] per-iteration timings(ms)', timings.map((t) => Math.round(t)));
	return { before, after, timings };
};
