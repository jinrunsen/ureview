import { describe, expect, it } from "vitest";
import { resolveReviewPage } from "./review-pagination";

describe("评审列表分页收敛", () => {
  it("进行中列表从二十一条降到十九条时退回第一页", () => {
    expect(resolveReviewPage(2, 21, 20)).toEqual({ page: 2, pages: 2 });
    expect(resolveReviewPage(2, 19, 20)).toEqual({ page: 1, pages: 1 });
  });
  it("恰好一页及空列表不会留下空的尾页", () => {
    expect(resolveReviewPage(2, 20, 20)).toEqual({ page: 1, pages: 1 });
    expect(resolveReviewPage(4, 0, 20)).toEqual({ page: 1, pages: 1 });
  });
  it("记录增加或总数变化但当前页仍有效时保持阅读页码", () => {
    expect(resolveReviewPage(2, 80, 20)).toEqual({ page: 2, pages: 4 });
    expect(resolveReviewPage(2, 40, 20)).toEqual({ page: 2, pages: 2 });
  });
});
