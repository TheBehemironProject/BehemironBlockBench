// UVEditor GL — Shader 常量集中管理
// Sprint 1: cube_uv_face 填色 shader（描边由 outlineLayer 用 LineSegments 独立画）
//
// 状态编码（iState / uFillColors 数组下标）：
//   0 = unselected   (display_uv=all_elements 时其他元素的面)
//   1 = default      (可选中但未选中)
//   2 = hover
//   3 = selected
//   4 = selected-primary  (selected + mode==uv 的主角面)
//
// 位置坐标系：屏幕像素（0,0 左上，y 向下），与 OrthographicCamera(0,w,0,h) 对齐。

export const FACE_STATE = Object.freeze({
	UNSELECTED: 0,
	DEFAULT: 1,
	HOVER: 2,
	SELECTED: 3,
	SELECTED_PRIMARY: 4,
});

export const FACE_STATE_COUNT = 5;

// cube_uv_face 顶点着色器
export const FACE_VERTEX_SHADER = /* glsl */`
precision highp float;

// position / projectionMatrix / modelViewMatrix 由 THREE.ShaderMaterial 自动注入声明,
// 不能在这里重复 declare —— WebGL2(#version 300 es)下会报 'redefinition' 编译错误
// (WebGL1 部分驱动能容忍,WebGL2 严格报错)。这里只声明真正自定义的 per-instance attribute。
attribute vec2 iOffset;          // 面左上角像素坐标
attribute vec2 iSize;            // 面像素尺寸
attribute float iState;          // 状态编码
attribute float iZ;              // z 深度提示（selected 面浮到上层）

varying float vState;

void main() {
	vec2 worldPos = iOffset + position.xy * iSize;
	vState = iState;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, iZ, 1.0);
}
`;

// cube_uv_face 片元着色器
export const FACE_FRAGMENT_SHADER = /* glsl */`
precision highp float;

varying float vState;
uniform vec4 uFillColors[${FACE_STATE_COUNT}]; // rgba per state

void main() {
	int s = int(vState + 0.5);
	vec4 col = uFillColors[0];
	if (s == 1) col = uFillColors[1];
	else if (s == 2) col = uFillColors[2];
	else if (s == 3) col = uFillColors[3];
	else if (s == 4) col = uFillColors[4];
	if (col.a <= 0.001) discard;
	gl_FragColor = col;
}
`;
