import { describe, expect, it } from "vitest";
import { formatElapsedDuration, getToolActionLabel } from "../src/features/chat/process-activity-group.js";

describe("过程摘要格式", () => {
  it("显示具体工具动作名称", () => {
    expect(getToolActionLabel("execute")).toBe("执行了命令");
    expect(getToolActionLabel("read_file")).toBe("分析了文件");
    expect(getToolActionLabel("edit_file")).toBe("编辑了文件");
    expect(getToolActionLabel("write_file")).toBe("写入了文件");
  });

  it("用分钟和秒显示耗时", () => {
    expect(formatElapsedDuration(0)).toBe("0分0秒");
    expect(formatElapsedDuration(125_999)).toBe("2分5秒");
  });
});
