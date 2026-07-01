// UVEditor GL — Selected face 名字 Sprite 缓存
// 未接入:选中面的名字文字目前仍随 .uv_face_handles / .uv_mesh_vertex_handles 一起用 DOM
// 渲染(见 uv.js 的 getUVFaceHandleEntries),这部分 GL 化被有意搁置——文字数量恒定
// 跟着"当前选中面数"走,不属于"防止全选爆炸 DOM"这个核心目标,继续迁移收益有限。
// 这个模块先留作空壳,真要做的话往这里填充 CanvasTexture 生成/缓存逻辑。

export class UVGLLabelPool {
	constructor() {
		this.cache = new Map(); // key: "text|font|color" → THREE.CanvasTexture
	}

	get(_text, _font, _color) {
		return null; // 未接入,预留:返回 CanvasTexture
	}

	dispose() {
		for (let tex of this.cache.values()) {
			if (tex && tex.dispose) tex.dispose();
		}
		this.cache.clear();
	}
}
