/**
 * Save a rendered report as an A4 PDF straight to the user's downloads (no print dialog).
 *
 * The report element is captured as it looks on screen, then cut into pages. Page breaks are
 * placed at the bottom of a section, card or table row where possible, so text and charts are
 * not sliced through the middle. The libraries load only when someone asks for a PDF.
 */

const PAGE_W_MM = 210;
const PAGE_H_MM = 297;
const MARGIN_MM = 12;
const PIXEL_RATIO = 2;
const EXPORTING_CLASS = 'rp-exporting';

/** Bottom edges (in CSS px from the top of `root`) where a page may end. */
function breakCandidates(root) {
  const top = root.getBoundingClientRect().top;
  const out = new Set();
  const visit = (el, depth) => {
    for (const child of el.children) {
      const r = child.getBoundingClientRect();
      if (r.height === 0) continue;
      out.add(Math.round(r.bottom - top));
      // Go into sections, cards and tables so long ones can break between rows.
      if (depth < 4) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return [...out].sort((a, b) => a - b);
}

/** Choose page ends: the last safe break that fits, or a hard cut if a block is taller than a page. */
function pageBreaks(totalH, pageH, candidates) {
  const ends = [];
  let start = 0;
  while (start < totalH - 1) {
    const limit = start + pageH;
    if (limit >= totalH) {
      ends.push(totalH);
      break;
    }
    let end = limit;
    for (const c of candidates) {
      if (c > limit) break;
      if (c > start + pageH * 0.35) end = c;
    }
    ends.push(end);
    start = end;
  }
  return ends;
}

/**
 * @param {HTMLElement} root  the report element
 * @param {string} filename   e.g. "kpi-reporting-2026-11-09_2026-11-14.pdf"
 */
export async function downloadReportPdf(root, filename) {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);

  // Hide buttons and links (anything marked no-print) so the layout we measure is the one we capture.
  root.classList.add(EXPORTING_CLASS);
  try {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const widthPx = root.scrollWidth;
    const heightPx = root.scrollHeight;
    const candidates = breakCandidates(root);

    const canvas = await toCanvas(root, {
      pixelRatio: PIXEL_RATIO,
      backgroundColor: '#ffffff',
      width: widthPx,
      height: heightPx,
      cacheBust: true,
    });

    const contentWmm = PAGE_W_MM - MARGIN_MM * 2;
    const contentHmm = PAGE_H_MM - MARGIN_MM * 2;
    const mmPerPx = contentWmm / widthPx;
    const pageHpx = Math.floor(contentHmm / mmPerPx);
    const ends = pageBreaks(heightPx, pageHpx, candidates);

    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const slice = document.createElement('canvas');
    const ctx = slice.getContext('2d');
    let start = 0;
    ends.forEach((end, i) => {
      const hPx = end - start;
      slice.width = canvas.width;
      slice.height = Math.max(1, Math.round(hPx * PIXEL_RATIO));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(
        canvas,
        0, Math.round(start * PIXEL_RATIO), canvas.width, slice.height,
        0, 0, slice.width, slice.height,
      );
      if (i > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', MARGIN_MM, MARGIN_MM, contentWmm, hPx * mmPerPx);
      pdf.setFontSize(8);
      pdf.setTextColor(150);
      pdf.text(`${i + 1} / ${ends.length}`, PAGE_W_MM - MARGIN_MM, PAGE_H_MM - 5, { align: 'right' });
      start = end;
    });

    pdf.save(filename);
  } finally {
    root.classList.remove(EXPORTING_CLASS);
  }
}

