export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function pageToCssRect(rect, page, width, height) {
  return { left: rect.x / page.widthPt * width, top: rect.y / page.heightPt * height, width: rect.width / page.widthPt * width, height: rect.height / page.heightPt * height };
}

export function cssToPageRect(rect, page, width, height) {
  return { x: rect.left / width * page.widthPt, y: rect.top / height * page.heightPt, width: rect.width / width * page.widthPt, height: rect.height / height * page.heightPt };
}
