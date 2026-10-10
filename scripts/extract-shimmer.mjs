import fs from "fs";

const content = fs.readFileSync("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/.system_generated/steps/1521/content.md", "utf8");

// 查找包含 export const Shimmer 或者 export function Shimmer 的代码
const idx = content.indexOf("export const Shimmer");
const idx2 = content.indexOf("export function Shimmer");
const target = idx !== -1 ? idx : idx2;
if (target !== -1) {
  console.log("找到 Shimmer 实现:");
  console.log(content.slice(Math.max(0, target - 500), target + 1500));
} else {
  // 查找包含 MotionComponent 或 Motion 的地方
  console.log("查找 class 样式或 CSS 变量");
  const matches = content.match(/background-image:[^"]+/g);
  console.log("matches:", matches?.slice(0, 5));
}
