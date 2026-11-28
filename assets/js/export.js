/* =====================================================================
   PRAN NÒT - export.js
   Export des notes (PDF, Word .docx, Markdown) et des devoirs
   avec page de couverture universitaire professionnelle (3 modèles),
   table des matières, pagination, en-têtes et pieds de page.

   Fonksyon adisyonèl / Fonctions additionnelles (settings.js):
   - exportNoteAsWord     : ekspòte yon sèl nòt an .docx (esm.sh/docx@8)
   - exportNotesAsWord    : ekspòte plizyè nòt an .docx
   - exportAllDataAsJSON  : ekspòte tout done kont an JSON
   - exportNoteAsPDF      : ouvri fenèt pou enpresyon PDF (window.print)
   - importFromWord       : ekstrè tèks nan fichye .docx (mammoth UMD)
   ===================================================================== */
import { CDN, loadScript, downloadBlob, safeFilename, htmlToText } from './utils.js';
import { formatDate, getLang, t } from './i18n.js';

/** Convertit du HTML simple en blocs structurés { kind, text, level }. */
function parseHtmlBlocks(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const blocks = [];
  const root = doc.body.firstChild;

  const walk = (node) => {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === 3) {
        const txt = child.textContent.trim();
        if (txt) blocks.push({ kind: 'p', text: txt });
        return;
      }
      if (child.nodeType !== 1) return;
      const tag = child.tagName;
      if (/^H[1-4]$/.test(tag)) {
        const txt = child.textContent.trim();
        if (txt) blocks.push({ kind: 'h', level: Number(tag[1]), text: txt });
      } else if (tag === 'UL' || tag === 'OL') {
        Array.from(child.querySelectorAll(':scope > li')).forEach((li, i) => {
          const txt = li.textContent.trim();
          if (txt) blocks.push({ kind: 'li', ordered: tag === 'OL', index: i + 1, text: txt });
        });
      } else if (tag === 'BLOCKQUOTE') {
        const txt = child.textContent.trim();
        if (txt) blocks.push({ kind: 'quote', text: txt });
      } else if (tag === 'P' || tag === 'DIV' || tag === 'PRE') {
        const txt = child.textContent.trim();
        if (txt) blocks.push({ kind: 'p', text: txt });
      } else {
        walk(child);
      }
    });
  };
  walk(root);
  if (!blocks.length && html) {
    const plain = htmlToText(html);
    plain.split(/\n{2,}/).forEach((p) => {
      if (p.trim()) blocks.push({ kind: 'p', text: p.trim() });
    });
  }
  return blocks;
}

/** Exporte une note en Markdown (.md). */
export function exportNoteMarkdown(note, courseName = '') {
  const lines = [`# ${note.title || 'Nòt'}`];
  if (courseName) lines.push(`*Kou / Cours : ${courseName}*`);
  lines.push(`*Dat / Date : ${formatDate(note.updated_at || note.created_at || new Date())}*`, '');

  if (note.summary) {
    lines.push('## Rezime / Résumé', note.summary, '');
  }

  const blocks = parseHtmlBlocks(note.content_html || '');
  if (blocks.length) {
    blocks.forEach((b) => {
      if (b.kind === 'h') lines.push(`${'#'.repeat(Math.min(4, b.level + 1))} ${b.text}`, '');
      else if (b.kind === 'li') lines.push(b.ordered ? `${b.index}. ${b.text}` : `- ${b.text}`);
      else if (b.kind === 'quote') lines.push(`> ${b.text}`, '');
      else lines.push(b.text, '');
    });
  } else if (note.content_text) {
    lines.push(note.content_text, '');
  }

  const st = note.structured || {};
  if (Array.isArray(st.takeaways) && st.takeaways.length) {
    lines.push('## Pou kenbe / À retenir');
    st.takeaways.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }
  if (Array.isArray(st.keywords) && st.keywords.length) {
    lines.push(`**Mo kle / Mots-clés :** ${st.keywords.join(', ')}`, '');
  }
  if (Array.isArray(st.implied_points) && st.implied_points.length) {
    lines.push(getLang() === 'fr' ? '## Suggestions IA (sous-entendus du professeur)' : '## Sijesyon IA (sa pwofesè a souzantann)');
    st.implied_points.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }

  lines.push('---', 'Pran Nòt — Designed by Cvisual');
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, safeFilename(note.title || 'not', 'md'));
}

/** Exporte une note en PDF (A4, jsPDF). */
export async function exportNotePdf(note, profile = null, courseName = '') {
  await loadScript(CDN.jspdf);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 18;
  const maxW = pageW - margin * 2;
  let y = 24;

  const ensureSpace = (needed = 12) => {
    if (y + needed > pageH - 20) {
      doc.addPage();
      y = 24;
    }
  };

  // En-tête document
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(249, 115, 22);
  doc.text('PRAN NÒT', margin, 14);
  doc.setTextColor(91, 102, 128);
  doc.setFont('helvetica', 'normal');
  if (courseName) doc.text(courseName.slice(0, 60), pageW - margin, 14, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(27, 42, 74);
  const titleLines = doc.splitTextToSize(note.title || 'Nòt', maxW);
  doc.text(titleLines, margin, y);
  y += titleLines.length * 7.5 + 2;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(91, 102, 128);
  const metaParts = [formatDate(note.updated_at || note.created_at || new Date())];
  if (profile?.full_name) metaParts.push(profile.full_name);
  doc.text(metaParts.join('  |  '), margin, y);
  y += 6;
  doc.setDrawColor(229, 231, 235);
  doc.line(margin, y, pageW - margin, y);
  y += 8;

  if (note.summary) {
    ensureSpace(22);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(27, 42, 74);
    doc.text('Rezime / Résumé', margin, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(58, 72, 102);
    const sumLines = doc.splitTextToSize(note.summary, maxW);
    sumLines.forEach((l) => { ensureSpace(6); doc.text(l, margin, y); y += 5; });
    y += 4;
  }

  const blocks = parseHtmlBlocks(note.content_html || '');
  if (!blocks.length && note.content_text) blocks.push({ kind: 'p', text: note.content_text });

  blocks.forEach((b) => {
    if (b.kind === 'h') {
      ensureSpace(14);
      y += 3;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(b.level === 1 ? 14 : b.level === 2 ? 12.5 : 11);
      doc.setTextColor(27, 42, 74);
      const lines = doc.splitTextToSize(b.text, maxW);
      lines.forEach((l) => { ensureSpace(7); doc.text(l, margin, y); y += 6; });
      y += 1.5;
    } else if (b.kind === 'li') {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(27, 42, 74);
      const prefix = b.ordered ? `${b.index}. ` : '- ';
      const lines = doc.splitTextToSize(prefix + b.text, maxW - 4);
      lines.forEach((l) => { ensureSpace(6); doc.text(l, margin + 3, y); y += 5.2; });
      y += 1;
    } else {
      doc.setFont('helvetica', b.kind === 'quote' ? 'italic' : 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(27, 42, 74);
      const lines = doc.splitTextToSize(b.text, maxW);
      lines.forEach((l) => { ensureSpace(6); doc.text(l, margin, y); y += 5.2; });
      y += 3;
    }
  });

  const st = note.structured || {};
  if (Array.isArray(st.takeaways) && st.takeaways.length) {
    ensureSpace(18);
    y += 3;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(27, 42, 74);
    doc.text('Pou kenbe / À retenir', margin, y);
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    st.takeaways.forEach((item) => {
      const lines = doc.splitTextToSize(`- ${item}`, maxW - 4);
      lines.forEach((l) => { ensureSpace(6); doc.text(l, margin + 2, y); y += 5; });
    });
  }

  // Pieds de page numérotés
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(107, 114, 128);
    doc.text('Pran Nòt — Designed by Cvisual', margin, pageH - 10);
    doc.text(`${i} / ${pages}`, pageW - margin, pageH - 10, { align: 'right' });
  }

  doc.save(safeFilename(note.title || 'not', 'pdf'));
}

/** Exporte une note en Word (.docx). */
export async function exportNoteDocx(note, profile = null, courseName = '') {
  await loadScript(CDN.docx);
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = window.docx;

  const children = [
    new Paragraph({
      children: [
        new TextRun({ text: 'PRAN NÒT', bold: true, color: 'F97316', size: 18 }),
        courseName ? new TextRun({ text: `   |   ${courseName}`, color: '5B6680', size: 18 }) : new TextRun(''),
      ],
      spacing: { after: 160 },
    }),
    new Paragraph({
      text: note.title || 'Nòt',
      heading: HeadingLevel.TITLE,
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: [formatDate(note.updated_at || note.created_at || new Date()), profile?.full_name].filter(Boolean).join(' — '),
          color: '5B6680',
          size: 20,
        }),
      ],
      spacing: { after: 280 },
    }),
  ];

  if (note.summary) {
    children.push(new Paragraph({ text: 'Rezime / Résumé', heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 80 } }));
    children.push(new Paragraph({ text: note.summary, spacing: { after: 200 } }));
  }

  const blocks = parseHtmlBlocks(note.content_html || '');
  if (!blocks.length && note.content_text) blocks.push({ kind: 'p', text: note.content_text });

  blocks.forEach((b) => {
    if (b.kind === 'h') {
      const hMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
      children.push(new Paragraph({ text: b.text, heading: hMap[b.level] || HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }));
    } else if (b.kind === 'li') {
      children.push(new Paragraph({ text: b.ordered ? `${b.index}. ${b.text}` : `• ${b.text}`, spacing: { after: 80 }, indent: { left: 360 } }));
    } else {
      children.push(new Paragraph({ text: b.text, spacing: { after: 140 } }));
    }
  });

  const st = note.structured || {};
  if (Array.isArray(st.takeaways) && st.takeaways.length) {
    children.push(new Paragraph({ text: 'Pou kenbe / À retenir', heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 100 } }));
    st.takeaways.forEach((tItem) => children.push(new Paragraph({ text: `• ${tItem}`, spacing: { after: 80 }, indent: { left: 360 } })));
  }

  const wordDoc = new Document({
    sections: [{ properties: {}, children }],
  });
  const blob = await Packer.toBlob(wordDoc);
  downloadBlob(blob, safeFilename(note.title || 'not', 'docx'));
}

/* =====================================================================
   EXPORT DE DEVOIRS AVEC PAGE DE COUVERTURE UNIVERSITAIRE
   Modèles : 'classic' (encadré académique), 'modern' (filet orange), 'minimal' (épuré)
   ===================================================================== */

function buildCoverMeta(assignment, profile, course) {
  const c = assignment.cover || {};
  const isFr = getLang() === 'fr';
  return {
    template: c.template || 'classic',
    university: c.university || profile?.university || (isFr ? 'Université' : 'Inivèsite'),
    faculty: c.faculty || (isFr ? (profile?.faculty?.name_fr || 'Faculté') : (profile?.faculty?.name_ht || profile?.faculty?.name_fr || 'Fakilte')),
    course: c.course || course?.name || (isFr ? 'Cours' : 'Kou'),
    professor: c.professor || course?.professor || '',
    title: assignment.title || (isFr ? 'Travail académique' : 'Devwa'),
    student: c.student || profile?.full_name || (isFr ? 'Étudiant' : 'Etidyan'),
    level: c.level || profile?.level || '',
    date: c.date || formatDate(new Date()),
  };
}

/** Exporte un devoir en PDF avec page de couverture, table des matières, en-tête et pagination. */
export async function exportAssignmentPdf(assignment, profile = null, course = null) {
  await loadScript(CDN.jspdf);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 22;
  const maxW = pageW - margin * 2;
  const meta = buildCoverMeta(assignment, profile, course);

  // ---- PAGE 1 : PAGE DE COUVERTURE ----
  if (meta.template === 'classic') {
    doc.setDrawColor(27, 42, 74);
    doc.setLineWidth(0.7);
    doc.rect(14, 14, pageW - 28, pageH - 28);
    doc.setLineWidth(0.2);
    doc.rect(16.5, 16.5, pageW - 33, pageH - 33);
  } else if (meta.template === 'modern') {
    doc.setFillColor(249, 115, 22);
    doc.rect(18, 22, 4, pageH - 44, 'F');
  } else {
    doc.setDrawColor(229, 231, 235);
    doc.line(margin, 52, pageW - margin, 52);
  }

  const alignCenter = meta.template === 'classic';
  const xAnchor = alignCenter ? pageW / 2 : (meta.template === 'modern' ? 32 : margin);
  const alignOpt = alignCenter ? { align: 'center' } : undefined;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(27, 42, 74);
  doc.text(meta.university.toUpperCase(), xAnchor, 34, alignOpt);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(91, 102, 128);
  doc.text(meta.faculty, xAnchor, 42, alignOpt);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(249, 115, 22);
  doc.text(meta.course, xAnchor, 78, alignOpt);

  if (meta.professor) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(91, 102, 128);
    doc.text(`${getLang() === 'fr' ? 'Professeur' : 'Pwofesè'} : ${meta.professor}`, xAnchor, 86, alignOpt);
  }

  // Titre du devoir
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(27, 42, 74);
  const titleLines = doc.splitTextToSize(meta.title, alignCenter ? maxW - 12 : maxW - 10);
  doc.text(titleLines, xAnchor, 128, alignOpt);

  // Bloc étudiant en bas de couverture
  const infoY = pageH - 64;
  doc.setDrawColor(229, 231, 235);
  doc.line(margin, infoY - 10, pageW - margin, infoY - 10);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(27, 42, 74);
  doc.text(`${getLang() === 'fr' ? 'Étudiant' : 'Etidyan'} : ${meta.student}`, xAnchor, infoY, alignOpt);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(91, 102, 128);
  if (meta.level) doc.text(`${getLang() === 'fr' ? 'Niveau' : 'Nivo'} : ${meta.level}`, xAnchor, infoY + 8, alignOpt);
  doc.text(`${getLang() === 'fr' ? 'Date' : 'Dat'} : ${meta.date}`, xAnchor, infoY + 16, alignOpt);

  // ---- CONTENU ET TABLE DES MATIÈRES ----
  const blocks = parseHtmlBlocks(assignment.content_html || '');
  const headings = blocks.filter((b) => b.kind === 'h');

  if (headings.length) {
    doc.addPage();
    let ty = 30;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(27, 42, 74);
    doc.text(getLang() === 'fr' ? 'Table des matières' : 'Tab matyè', margin, ty);
    ty += 10;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    headings.forEach((h, idx) => {
      if (ty > pageH - 25) { doc.addPage(); ty = 30; }
      const indent = (h.level - 1) * 5;
      doc.text(`${idx + 1}. ${h.text}`, margin + indent, ty);
      ty += 7;
    });
  }

  doc.addPage();
  let y = 28;
  const ensureSpace = (n = 12) => {
    if (y + n > pageH - 22) { doc.addPage(); y = 28; }
  };

  if (!blocks.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(91, 102, 128);
    doc.text(assignment.instructions || meta.title, margin, y);
  } else {
    blocks.forEach((b) => {
      if (b.kind === 'h') {
        ensureSpace(16);
        y += 4;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(b.level === 1 ? 14 : b.level === 2 ? 12.5 : 11);
        doc.setTextColor(27, 42, 74);
        const lines = doc.splitTextToSize(b.text, maxW);
        lines.forEach((l) => { ensureSpace(7); doc.text(l, margin, y); y += 6.5; });
        y += 2;
      } else if (b.kind === 'li') {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(27, 42, 74);
        const prefix = b.ordered ? `${b.index}. ` : '- ';
        const lines = doc.splitTextToSize(prefix + b.text, maxW - 4);
        lines.forEach((l) => { ensureSpace(6); doc.text(l, margin + 4, y); y += 5.6; });
        y += 1.5;
      } else {
        doc.setFont('helvetica', b.kind === 'quote' ? 'italic' : 'normal');
        doc.setFontSize(11);
        doc.setTextColor(27, 42, 74);
        const lines = doc.splitTextToSize(b.text, maxW);
        lines.forEach((l) => { ensureSpace(6); doc.text(l, margin, y); y += 5.8; });
        y += 3.5;
      }
    });
  }

  // En-têtes et pieds de page (à partir de la page 2)
  const totalPages = doc.getNumberOfPages();
  for (let i = 2; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(107, 114, 128);
    doc.text(meta.title.slice(0, 55), margin, 14);
    doc.text(meta.student, pageW - margin, 14, { align: 'right' });
    doc.setDrawColor(229, 231, 235);
    doc.line(margin, 17, pageW - margin, 17);

    doc.text(meta.course.slice(0, 50), margin, pageH - 11);
    doc.text(`Paj ${i - 1} / ${totalPages - 1}`, pageW - margin, pageH - 11, { align: 'right' });
  }

  doc.save(safeFilename(meta.title, 'pdf'));
}

/** Exporte un devoir en Word (.docx) avec page de couverture et corps structuré. */
export async function exportAssignmentDocx(assignment, profile = null, course = null) {
  await loadScript(CDN.docx);
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak, Header, Footer, PageNumber,
  } = window.docx;
  const meta = buildCoverMeta(assignment, profile, course);
  const align = meta.template === 'classic' ? AlignmentType.CENTER : AlignmentType.LEFT;

  const coverChildren = [
    new Paragraph({
      alignment: align,
      children: [new TextRun({ text: meta.university.toUpperCase(), bold: true, size: 28, color: '1B2A4A' })],
      spacing: { before: 400, after: 120 },
    }),
    new Paragraph({
      alignment: align,
      children: [new TextRun({ text: meta.faculty, size: 24, color: '5B6680' })],
      spacing: { after: 900 },
    }),
    new Paragraph({
      alignment: align,
      children: [new TextRun({ text: meta.course, bold: true, size: 24, color: 'F97316' })],
      spacing: { after: 120 },
    }),
    ...(meta.professor
      ? [new Paragraph({
          alignment: align,
          children: [new TextRun({ text: `${getLang() === 'fr' ? 'Professeur' : 'Pwofesè'} : ${meta.professor}`, size: 22, color: '5B6680' })],
          spacing: { after: 1200 },
        })]
      : [new Paragraph({ text: '', spacing: { after: 1200 } })]),
    new Paragraph({
      alignment: align,
      children: [new TextRun({ text: meta.title, bold: true, size: 44, color: '1B2A4A' })],
      spacing: { after: 2000 },
    }),
    new Paragraph({
      alignment: align,
      children: [new TextRun({ text: `${getLang() === 'fr' ? 'Étudiant' : 'Etidyan'} : ${meta.student}`, bold: true, size: 24, color: '1B2A4A' })],
      spacing: { after: 100 },
    }),
    ...(meta.level
      ? [new Paragraph({ alignment: align, children: [new TextRun({ text: `${getLang() === 'fr' ? 'Niveau' : 'Nivo'} : ${meta.level}`, size: 22, color: '5B6680' })], spacing: { after: 100 } })]
      : []),
    new Paragraph({
      alignment: align,
      children: [new TextRun({ text: `${getLang() === 'fr' ? 'Date' : 'Dat'} : ${meta.date}`, size: 22, color: '5B6680' })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  const blocks = parseHtmlBlocks(assignment.content_html || '');
  const headings = blocks.filter((b) => b.kind === 'h');
  const bodyChildren = [];

  if (headings.length) {
    bodyChildren.push(new Paragraph({ text: getLang() === 'fr' ? 'Table des matières' : 'Tab matyè', heading: HeadingLevel.HEADING_1, spacing: { after: 160 } }));
    headings.forEach((h, i) => {
      bodyChildren.push(new Paragraph({ text: `${i + 1}. ${h.text}`, spacing: { after: 80 }, indent: { left: (h.level - 1) * 300 } }));
    });
    bodyChildren.push(new Paragraph({ children: [new PageBreak()] }));
  }

  if (!blocks.length) {
    bodyChildren.push(new Paragraph({ text: assignment.instructions || meta.title }));
  } else {
    blocks.forEach((b) => {
      if (b.kind === 'h') {
        const hMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
        bodyChildren.push(new Paragraph({ text: b.text, heading: hMap[b.level] || HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } }));
      } else if (b.kind === 'li') {
        bodyChildren.push(new Paragraph({ text: b.ordered ? `${b.index}. ${b.text}` : `• ${b.text}`, spacing: { after: 100 }, indent: { left: 360 } }));
      } else {
        bodyChildren.push(new Paragraph({ text: b.text, spacing: { after: 160 } }));
      }
    });
  }

  const wordDoc = new Document({
    sections: [
      { properties: { titlePage: true }, children: coverChildren },
      {
        properties: {},
        headers: {
          default: new Header({
            children: [new Paragraph({ children: [new TextRun({ text: `${meta.title} — ${meta.student}`, size: 18, color: '5B6680' })] })],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: `${meta.course}   |   Paj `, size: 18, color: '5B6680' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '5B6680' }),
                ],
              }),
            ],
          }),
        },
        children: bodyChildren,
      },
    ],
  });

  const blob = await Packer.toBlob(wordDoc);
  downloadBlob(blob, safeFilename(meta.title, 'docx'));
}

/* =====================================================================
   EXPORT DE LIVRES & MANUELS DE LA BIBLIOTHÈQUE (PDF / WORD .DOCX)
   ===================================================================== */

/** Exporte un livre / manuel (ou code annoté) en PDF avec couverture et table des matières. */
export async function exportBookPdf(book, profile = null) {
  await loadScript(CDN.jspdf);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;
  const maxW = pageW - margin * 2;
  const meta = book?.metadata || {};
  const title = book?.title || 'Livre Pran Nòt';
  const subtitle = meta.subtitle || book?.description || '';
  const author = book?.author || profile?.full_name || 'Pran Nòt Studio IA';
  const origScore = meta.originality_score;

  // Couverture
  doc.setFillColor(27, 42, 74);
  doc.rect(0, 0, 12, pageH, 'F');
  doc.setFillColor(249, 115, 22);
  doc.rect(12, 0, 3, pageH, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(249, 115, 22);
  doc.text('PRAN NÒT — BIBLIYOTÈK AK KREYATÈ LIV', margin + 6, 32);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(27, 42, 74);
  const tLines = doc.splitTextToSize(title, maxW - 8);
  doc.text(tLines, margin + 6, 68);

  let cy = 68 + tLines.length * 9 + 6;
  if (subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.setTextColor(91, 102, 128);
    const sLines = doc.splitTextToSize(subtitle, maxW - 8);
    doc.text(sLines, margin + 6, cy);
    cy += sLines.length * 6 + 6;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(27, 42, 74);
  doc.text(`Otè / Sous : ${author}`, margin + 6, pageH - 52);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(91, 102, 128);
  const footerMeta = [
    book?.country || 'Haïti',
    book?.publication_year || new Date().getFullYear(),
    typeof origScore === 'number' ? `Orijinalite verifye : ${origScore}%` : null,
  ].filter(Boolean).join('  |  ');
  doc.text(footerMeta, margin + 6, pageH - 44);
  doc.text(`Dat edisyon : ${formatDate(book?.updated_at || new Date())}`, margin + 6, pageH - 36);

  // Corps structuré
  const blocks = parseHtmlBlocks(book?.content_html || '');
  if (!blocks.length && book?.summary) {
    blocks.push({ kind: 'p', text: book.summary });
  }

  doc.addPage();
  let y = 26;
  const ensureSpace = (n = 12) => {
    if (y + n > pageH - 22) { doc.addPage(); y = 26; }
  };

  blocks.forEach((b) => {
    if (b.kind === 'h') {
      ensureSpace(16);
      y += 4;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(b.level === 1 ? 15 : b.level === 2 ? 13 : 11.5);
      doc.setTextColor(27, 42, 74);
      const lines = doc.splitTextToSize(b.text, maxW);
      lines.forEach((l) => { ensureSpace(7); doc.text(l, margin, y); y += 6.5; });
      y += 2;
    } else if (b.kind === 'li') {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(27, 42, 74);
      const prefix = b.ordered ? `${b.index}. ` : '- ';
      const lines = doc.splitTextToSize(prefix + b.text, maxW - 4);
      lines.forEach((l) => { ensureSpace(6); doc.text(l, margin + 4, y); y += 5.5; });
      y += 1.2;
    } else {
      doc.setFont('helvetica', b.kind === 'quote' ? 'italic' : 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(27, 42, 74);
      const lines = doc.splitTextToSize(b.text, maxW);
      lines.forEach((l) => { ensureSpace(6); doc.text(l, margin, y); y += 5.5; });
      y += 3;
    }
  });

  const totalPages = doc.getNumberOfPages();
  for (let i = 2; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(107, 114, 128);
    doc.text(title.slice(0, 62), margin, 14);
    doc.text('Pran Nòt — Designed by Cvisual', margin, pageH - 10);
    doc.text(`Paj ${i - 1} / ${totalPages - 1}`, pageW - margin, pageH - 10, { align: 'right' });
  }

  doc.save(safeFilename(title, 'pdf'));
}

/** Exporte un livre / manuel en Word (.docx). */
export async function exportBookDocx(book, profile = null) {
  await loadScript(CDN.docx);
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak, Header, Footer, PageNumber, AlignmentType } = window.docx;
  const meta = book?.metadata || {};
  const title = book?.title || 'Livre Pran Nòt';
  const subtitle = meta.subtitle || book?.description || '';
  const author = book?.author || profile?.full_name || 'Pran Nòt Studio IA';

  const coverChildren = [
    new Paragraph({
      children: [new TextRun({ text: 'PRAN NÒT — BIBLIYOTÈK INIVÈSITÈ', bold: true, size: 22, color: 'F97316' })],
      spacing: { before: 500, after: 400 },
    }),
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 48, color: '1B2A4A' })],
      spacing: { after: 240 },
    }),
    ...(subtitle ? [new Paragraph({ children: [new TextRun({ text: subtitle, italics: true, size: 26, color: '5B6680' })], spacing: { after: 1400 } })] : []),
    new Paragraph({
      children: [new TextRun({ text: `Otè / Sous : ${author}`, bold: true, size: 24, color: '1B2A4A' })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({
        text: [
          book?.country || 'Haïti',
          typeof meta.originality_score === 'number' ? `Orijinalite : ${meta.originality_score}%` : null,
          formatDate(book?.updated_at || new Date()),
        ].filter(Boolean).join('   |   '),
        size: 20,
        color: '5B6680',
      })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  const blocks = parseHtmlBlocks(book?.content_html || '');
  if (!blocks.length && book?.summary) blocks.push({ kind: 'p', text: book.summary });

  const bodyChildren = blocks.map((b) => {
    if (b.kind === 'h') {
      const hMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4 };
      return new Paragraph({ text: b.text, heading: hMap[b.level] || HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 } });
    }
    if (b.kind === 'li') {
      return new Paragraph({ text: b.ordered ? `${b.index}. ${b.text}` : `• ${b.text}`, spacing: { after: 100 }, indent: { left: 360 } });
    }
    return new Paragraph({ text: b.text, spacing: { after: 160 } });
  });

  const wordDoc = new Document({
    sections: [
      { properties: { titlePage: true }, children: coverChildren },
      {
        properties: {},
        headers: {
          default: new Header({
            children: [new Paragraph({ children: [new TextRun({ text: title.slice(0, 75), size: 18, color: '5B6680' })] })],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: 'Pran Nòt   |   Paj ', size: 18, color: '5B6680' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '5B6680' }),
                ],
              }),
            ],
          }),
        },
        children: bodyChildren,
      },
    ],
  });

  const blob = await Packer.toBlob(wordDoc);
  downloadBlob(blob, safeFilename(title, 'docx'));
}





/* =====================================================================
   FONKSYON SETTINGS — ekspòtasyon JSON, PDF enpresyon, Word (esm.sh),
   enpòtasyon Word (mammoth UMD), efasaj kont.
   Ekspòte séparément de l'API existante pou chak kalite itilizasyon.
   ===================================================================== */

/** Lazily load docx@8 from esm.sh (ESM dynamic import, cached after first load). */
async function _loadDocxEsm() {
  return import('https://esm.sh/docx@8');
}

/** Load mammoth via UMD script tag (browser bundle — not an ES module). */
function _loadMammoth() {
  return new Promise((resolve, reject) => {
    if (window.mammoth) { resolve(window.mammoth); return; }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/mammoth/mammoth.browser.min.js';
    script.onload = () => resolve(window.mammoth);
    script.onerror = () => reject(new Error('mammoth_load_failed'));
    document.head.appendChild(script);
  });
}

/** Slugify a string for safe filenames. */
function _slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

/** Trigger a browser file download from a Blob. */
function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Format a Date or ISO string as YYYY-MM-DD. */
function _fmtDate(val) {
  if (!val) return new Date().toISOString().slice(0, 10);
  const d = typeof val === 'string' ? new Date(val) : val;
  return isNaN(d.getTime()) ? String(val).slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Minimal HTML escape used for the PDF print window. */
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Single-note Word export (settings / note-detail) ──────────────────

/**
 * Export a single note as a .docx using esm.sh/docx@8.
 * @param {object} note       – note row from pran_not_notes
 * @param {string} courseName – display name of the course
 */
export async function exportNoteAsWord(note, courseName) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  } = await _loadDocxEsm();

  const dateStr = _fmtDate(note.created_at);
  const children = [];

  children.push(
    new Paragraph({
      text: note.title || 'Nòt',
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
    }),
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `${courseName || ''} — ${dateStr}`,
          italics: true,
          color: '555555',
        }),
      ],
      alignment: AlignmentType.CENTER,
    }),
  );

  children.push(new Paragraph({ text: '' }));

  const bodyBlocks = (note.content || note.content_text || '').split(/\n\n+/);
  for (const block of bodyBlocks) {
    if (block.trim()) children.push(new Paragraph({ text: block.trim() }));
  }

  if (note.homework && String(note.homework).trim()) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ text: getLang() === 'fr' ? 'Devoirs' : 'Devwa', heading: HeadingLevel.HEADING_2 }));
    for (const item of String(note.homework).split(/\n/).filter(Boolean)) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: item.trim() })], bullet: { level: 0 } }),
      );
    }
  }

  if (note.corrections && String(note.corrections).trim()) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ text: getLang() === 'fr' ? 'Corrections IA' : 'Koreksyon IA', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: String(note.corrections).trim() }));
  }

  if (note.research_topics && String(note.research_topics).trim()) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ text: getLang() === 'fr' ? 'Sujets de recherche' : 'Sijè pou rechèche', heading: HeadingLevel.HEADING_2 }));
    for (const topic of String(note.research_topics).split(/\n/).filter(Boolean)) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: topic.trim() })], bullet: { level: 0 } }),
      );
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const blob = await Packer.toBlob(doc);
  _triggerDownload(blob, `note_${_slugify(note.title || 'note')}_${dateStr}.docx`);
}

// ── Multi-note Word export ─────────────────────────────────────────────

/**
 * Export multiple notes as a single .docx file — each note is a new section.
 * @param {object[]} notes – array of note rows
 * @param {string}   title – document title / filename base
 */
export async function exportNotesAsWord(notes, title) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await _loadDocxEsm();

  const sections = notes.map((note, i) => {
    const children = [];

    children.push(
      new Paragraph({
        text: note.title || `Nòt ${i + 1}`,
        heading: HeadingLevel.HEADING_1,
      }),
    );

    children.push(
      new Paragraph({
        children: [new TextRun({ text: _fmtDate(note.created_at), italics: true, color: '555555' })],
      }),
    );

    children.push(new Paragraph({ text: '' }));

    for (const block of (note.content || note.content_text || '').split(/\n\n+/)) {
      if (block.trim()) children.push(new Paragraph({ text: block.trim() }));
    }

    if (note.homework && String(note.homework).trim()) {
      children.push(new Paragraph({ text: '' }));
      children.push(new Paragraph({ text: getLang() === 'fr' ? 'Devoirs' : 'Devwa', heading: HeadingLevel.HEADING_2 }));
      for (const item of String(note.homework).split(/\n/).filter(Boolean)) {
        children.push(new Paragraph({ children: [new TextRun({ text: item.trim() })], bullet: { level: 0 } }));
      }
    }

    if (note.corrections && String(note.corrections).trim()) {
      children.push(new Paragraph({ text: '' }));
      children.push(new Paragraph({ text: getLang() === 'fr' ? 'Corrections IA' : 'Koreksyon IA', heading: HeadingLevel.HEADING_2 }));
      children.push(new Paragraph({ text: String(note.corrections).trim() }));
    }

    if (note.research_topics && String(note.research_topics).trim()) {
      children.push(new Paragraph({ text: '' }));
      children.push(new Paragraph({ text: getLang() === 'fr' ? 'Sujets de recherche' : 'Sijè pou rechèche', heading: HeadingLevel.HEADING_2 }));
      for (const topic of String(note.research_topics).split(/\n/).filter(Boolean)) {
        children.push(new Paragraph({ children: [new TextRun({ text: topic.trim() })], bullet: { level: 0 } }));
      }
    }

    return { properties: {}, children };
  });

  const doc = new Document({ sections });
  const blob = await Packer.toBlob(doc);
  const dateStr = _fmtDate(null);
  _triggerDownload(blob, `${_slugify(title || 'notes')}_${dateStr}.docx`);
}

// ── Full JSON export ───────────────────────────────────────────────────

/**
 * Fetch all user data from Supabase and trigger a .json download.
 * Works fully offline for locally-cached data via the existing Supabase client.
 * @param {string} userId – authenticated user ID
 * @param {object} db     – Supabase client instance
 */
export async function exportAllDataAsJSON(userId, db) {
  const [
    { data: courses },
    { data: notes },
    { data: assignments },
    { data: semesters },
  ] = await Promise.all([
    db.from('pran_not_courses').select('*').eq('user_id', userId),
    db.from('pran_not_notes').select('*').eq('user_id', userId),
    db.from('pran_not_assignments').select('*').eq('user_id', userId),
    db.from('pran_not_semesters').select('*').eq('user_id', userId),
  ]);

  const payload = {
    exported_at: new Date().toISOString(),
    user_id: userId,
    semesters: semesters || [],
    courses: courses || [],
    notes: notes || [],
    assignments: assignments || [],
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  _triggerDownload(blob, `pran_not_export_${_fmtDate(null)}.json`);
}

// ── PDF export via print window ────────────────────────────────────────

/**
 * Open a styled print-ready popup window and call window.print().
 * No server call — works fully offline.
 * @param {object} note       – note row
 * @param {string} courseName – display name of the course
 */
export function exportNoteAsPDF(note, courseName) {
  const dateStr = _fmtDate(note.created_at);

  const contentHtml = (note.content || note.content_text || '')
    .split(/\n\n+/)
    .filter((p) => p.trim())
    .map((p) => `<p>${_esc(p.trim())}</p>`)
    .join('');

  let extrasHtml = '';
  if (note.homework && String(note.homework).trim()) {
    const items = String(note.homework).split(/\n/).filter(Boolean)
      .map((i) => `<li>${_esc(i.trim())}</li>`).join('');
    extrasHtml += `<h2>${getLang() === 'fr' ? 'Devoirs' : 'Devwa'}</h2><ul>${items}</ul>`;
  }
  if (note.corrections && String(note.corrections).trim()) {
    extrasHtml += `<h2>Koreksyon IA</h2><p>${_esc(String(note.corrections).trim())}</p>`;
  }
  if (note.research_topics && String(note.research_topics).trim()) {
    const topics = String(note.research_topics).split(/\n/).filter(Boolean)
      .map((t) => `<li>${_esc(t.trim())}</li>`).join('');
    extrasHtml += `<h2>${getLang() === 'fr' ? 'Sujets de recherche' : 'Sijè pou rechèche'}</h2><ul>${topics}</ul>`;
  }

  const html = `<!DOCTYPE html>
<html lang="ht">
<head>
  <meta charset="utf-8">
  <title>${_esc(note.title || 'Nòt')} — Pran Nòt</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; color: #111; padding: 2cm; }
    h1 { font-size: 20pt; margin-bottom: 4px; }
    .subtitle { font-size: 11pt; color: #555; margin-bottom: 1.5em; font-style: italic; }
    h2 { font-size: 14pt; margin-top: 1.5em; margin-bottom: 0.4em; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
    p { margin-bottom: 0.8em; }
    ul { margin-left: 1.5em; margin-bottom: 0.8em; }
    li { margin-bottom: 0.3em; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${_esc(note.title || 'Nòt')}</h1>
  <div class="subtitle">${_esc(courseName || '')} — ${_esc(dateStr)}</div>
  ${contentHtml}
  ${extrasHtml}
  <script>window.onload = () => { window.print(); }<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  }
}

/**
 * Enprime oswa ekspòte plizyè nòt chwazi an yon sèl dokiman PDF konbine.
 * Génère un livret académique complet avec page de garde, table des matières,
 * séparateurs de pages, métadonnées du cours/professeur/date, et contenu bilingue.
 * Fonctionne 100% hors-ligne via impression navigateur (Enregistrer en PDF).
 *
 * @param {Array<object>} notes      - Liste des notes à inclure
 * @param {Map|object} coursesMap    - Map des cours id -> cours
 * @param {object} profile           - Profil étudiant (nom, faculté, université)
 */
export function batchPrintNotes(notes = [], coursesMap = new Map(), profile = null) {
  if (!Array.isArray(notes) || !notes.length) return;

  const getCourse = (cId) => {
    if (!cId) return null;
    if (coursesMap instanceof Map) return coursesMap.get(cId);
    return coursesMap[cId] || null;
  };

  const studentName = profile?.full_name || 'Etidyan / Étudiant';
  const facultyName = profile?.faculty?.name_fr || profile?.faculty_id || 'Faculté Universitaire';
  const uniName = profile?.university || 'Université d\'État d\'Haïti / Établissement Universitaire';
  const todayStr = _fmtDate(new Date());

  // Table des matières
  const tocRows = notes.map((n, idx) => {
    const c = getCourse(n.course_id);
    const dateStr = _fmtDate(n.created_at || n.updated_at);
    return `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-weight:bold;">#${idx + 1}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;"><a href="#note-doc-${idx + 1}" style="color:#1B2A4A;text-decoration:none;font-weight:600;">${_esc(n.title || 'Nòt san tit')}</a></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">${_esc(c?.name || 'Kou jeneral')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;">${_esc(c?.professor || '—')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">${_esc(dateStr)}</td>
      </tr>
    `;
  }).join('');

  // Contenu détaillé de chaque note
  const notesSections = notes.map((n, idx) => {
    const c = getCourse(n.course_id);
    const dateStr = _fmtDate(n.created_at || n.updated_at);
    const st = n.structured || {};

    let mainHtml = '';
    if (n.content_html) {
      mainHtml = n.content_html;
    } else if (n.content_text || n.content) {
      mainHtml = (n.content_text || n.content)
        .split(/\n\n+/)
        .filter(p => p.trim())
        .map(p => `<p>${_esc(p.trim())}</p>`)
        .join('');
    } else {
      mainHtml = `<p><em>Pa gen tèks detaye pou nòt sa a.</em></p>`;
    }

    let htHtml = '';
    if (st.content_html_ht) {
      htHtml = `
        <div style="margin-top:24px;padding:16px;background:#f8fafc;border-left:4px solid #F97316;border-radius:4px;">
          <h3 style="font-size:14pt;color:#ea580c;margin-bottom:10px;">🇭🇹 Vèsyon Kreyòl Ayisyen (Eksplikasyon Pwofondi)</h3>
          ${st.content_html_ht}
        </div>
      `;
    }

    let simpleExpHtml = '';
    if (st.simple_explanation_fr || st.simple_explanation_ht || st.simple_explanation) {
      simpleExpHtml = `
        <div style="margin-top:20px;padding:14px;background:#fffbeb;border-left:4px solid #f59e0b;border-radius:4px;">
          <h4 style="font-size:12pt;color:#b45309;margin-bottom:8px;">💡 Eksplikasyon Senp Entegre (Pou Konprann Rapid)</h4>
          ${st.simple_explanation_fr ? `<p style="margin-bottom:6px;"><strong>Français :</strong> ${_esc(st.simple_explanation_fr)}</p>` : ''}
          ${st.simple_explanation_ht ? `<p style="margin-bottom:0;"><strong>Kreyòl :</strong> ${_esc(st.simple_explanation_ht)}</p>` : ''}
          ${(!st.simple_explanation_fr && !st.simple_explanation_ht && st.simple_explanation) ? `<p style="margin-bottom:0;">${_esc(st.simple_explanation)}</p>` : ''}
        </div>
      `;
    }

    let examQaHtml = '';
    if (Array.isArray(st.exam_qa) && st.exam_qa.length) {
      const qas = st.exam_qa.map((qa, qIdx) => `
        <div style="margin-bottom:12px;padding:10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;">
          <p style="font-weight:bold;color:#166534;margin-bottom:4px;">Q${qIdx + 1} : ${_esc(qa.question)}</p>
          <p style="margin-bottom:4px;"><strong>Repons Modèl :</strong> ${_esc(qa.answer)}</p>
          ${qa.explanation ? `<p style="font-size:10pt;color:#475569;margin-bottom:0;"><em>Kritè : ${_esc(qa.explanation)}</em></p>` : ''}
        </div>
      `).join('');
      examQaHtml = `
        <div style="margin-top:20px;">
          <h4 style="font-size:12pt;color:#15803d;margin-bottom:8px;">📝 Kesyon & Repons Modèl pou Egzamen</h4>
          ${qas}
        </div>
      `;
    }

    let profQHtml = '';
    const profQuestions = Array.isArray(st.questions_for_professor) ? st.questions_for_professor : [];
    if (profQuestions.length) {
      const pqs = profQuestions.map((pq) => `
        <li style="margin-bottom:6px;">
          <strong>${_esc(pq.question)}</strong>
          ${pq.purpose ? `<br><span style="font-size:10pt;color:#64748b;">Objektif : ${_esc(pq.purpose)}</span>` : ''}
        </li>
      `).join('');
      profQHtml = `
        <div style="margin-top:20px;padding:12px;background:#f8fafc;border-left:3px solid #1B2A4A;border-radius:4px;">
          <h4 style="font-size:12pt;color:#1B2A4A;margin-bottom:8px;">❓ Kesyon pou poze Pwofesè a</h4>
          <ul style="margin-left:20px;margin-bottom:0;">${pqs}</ul>
        </div>
      `;
    }

    return `
      <section class="note-page" id="note-doc-${idx + 1}" style="page-break-before:always;break-before:page;padding-top:20px;">
        <!-- Header Note -->
        <div style="border-bottom:2px solid #1B2A4A;padding-bottom:10px;margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;font-size:10pt;color:#64748b;text-transform:uppercase;font-weight:bold;margin-bottom:4px;">
            <span>COURS : ${_esc(c?.name || 'Kou Jeneral')}</span>
            <span>DATE : ${_esc(dateStr)}</span>
          </div>
          ${c?.professor ? `<div style="font-size:10.5pt;color:#475569;margin-bottom:6px;"><strong>Enseignant :</strong> ${_esc(c.professor)}</div>` : ''}
          <h2 style="font-size:18pt;color:#1B2A4A;margin:0 0 4px 0;">${_esc(n.title || 'Nòt')}</h2>
          ${n.summary ? `<div style="background:#f1f5f9;padding:10px;border-radius:4px;font-style:italic;font-size:11pt;color:#334155;margin-top:8px;"><strong>Résumé :</strong> ${_esc(n.summary)}</div>` : ''}
        </div>

        <!-- Corps Français -->
        <div class="note-body" style="font-size:11.5pt;line-height:1.65;color:#1e293b;">
          ${mainHtml}
        </div>

        <!-- Vèsyon Kreyòl -->
        ${htHtml}

        <!-- Eksplikasyon Senp -->
        ${simpleExpHtml}

        <!-- Egzamen Q&A -->
        ${examQaHtml}

        <!-- Kesyon Pwofesè -->
        ${profQHtml}

        <div style="margin-top:24px;border-top:1px solid #cbd5e1;padding-top:8px;display:flex;justify-content:space-between;font-size:9pt;color:#94a3b8;">
          <span>Pran Nòt — Nòt #${idx + 1} sou ${notes.length}</span>
          <span>${_esc(n.title || '')}</span>
        </div>
      </section>
    `;
  }).join('');

  const fullHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Recueil de Notes (${notes.length} notes) — Pran Nòt</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #111827;
      background: #fff;
      padding: 1.5cm;
    }
    h1, h2, h3, h4 { color: #1B2A4A; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; }
    p { margin-bottom: 0.8em; }
    ul, ol { margin-left: 1.5em; margin-bottom: 0.8em; }
    li { margin-bottom: 0.3em; }
    blockquote { border-left: 3px solid #F97316; padding-left: 12px; margin: 12px 0; color: #475569; font-style: italic; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    @media print {
      body { padding: 0; margin: 0; }
      @page {
        margin: 1.5cm 1.5cm;
        size: A4;
      }
      .no-print { display: none !important; }
      .page-break { page-break-before: always; break-before: page; }
    }
  </style>
</head>
<body>
  <!-- Barre d'action supérieure (masquée à l'impression) -->
  <div class="no-print" style="position:sticky;top:0;background:#1B2A4A;color:#fff;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;z-index:9999;box-shadow:0 2px 10px rgba(0,0,0,0.15);margin:-1.5cm -1.5cm 1.5cm -1.5cm;">
    <div style="font-weight:bold;font-size:14pt;">📚 Pran Nòt — Recueil de ${notes.length} Notes Prêt pour Impression / PDF</div>
    <div style="display:flex;gap:10px;">
      <button onclick="window.print()" style="background:#F97316;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-weight:bold;font-size:11pt;cursor:pointer;">
        🖨️ Enprime / Sove an PDF
      </button>
      <button onclick="window.close()" style="background:rgba(255,255,255,0.2);color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;">
        Fèmen
      </button>
    </div>
  </div>

  <!-- Page de Garde du Recueil -->
  <div style="min-height:85vh;display:flex;flex-direction:column;justify-content:space-between;text-align:center;padding:40px 20px;border:3px double #1B2A4A;border-radius:8px;">
    <div>
      <h3 style="font-size:14pt;text-transform:uppercase;letter-spacing:1px;color:#475569;margin-bottom:6px;">${_esc(uniName)}</h3>
      <h4 style="font-size:13pt;color:#64748b;margin-bottom:30px;">${_esc(facultyName)}</h4>
      <div style="width:80px;height:4px;background:#F97316;margin:0 auto 40px auto;border-radius:2px;"></div>
      <h1 style="font-size:26pt;color:#1B2A4A;margin-bottom:12px;text-transform:uppercase;">RECUEIL DE NOTES DE COURS</h1>
      <h2 style="font-size:16pt;font-weight:normal;color:#ea580c;margin-bottom:30px;">KAYE NÒT INIVÈSITÈ KONBINE</h2>
      <p style="font-size:13pt;color:#334155;">Édition personnalisée regroupant <strong>${notes.length} séances de cours</strong></p>
    </div>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:20px;max-width:500px;margin:30px auto;text-align:left;">
      <p style="margin-bottom:8px;"><strong>Étudiant / Etidyan :</strong> ${_esc(studentName)}</p>
      <p style="margin-bottom:8px;"><strong>Faculté / Domèn :</strong> ${_esc(facultyName)}</p>
      <p style="margin-bottom:8px;"><strong>Nombre de cours inclus :</strong> ${notes.length} cours</p>
      <p style="margin-bottom:0;"><strong>Date d'édition :</strong> ${_esc(todayStr)}</p>
    </div>

    <div style="font-size:10pt;color:#94a3b8;">
      Plateforme Pran Nòt • Haïti • Conçu pour l'excellence académique universitaire
    </div>
  </div>

  <!-- Table des Matières -->
  <div style="page-break-before:always;break-before:page;padding-top:20px;margin-bottom:40px;">
    <h2 style="font-size:18pt;border-bottom:2px solid #1B2A4A;padding-bottom:6px;margin-bottom:16px;">TABLE DES MATIÈRES / LIS NÒT YO</h2>
    <table style="font-size:10.5pt;">
      <thead>
        <tr style="background:#f1f5f9;text-align:left;">
          <th style="padding:8px 10px;">#</th>
          <th style="padding:8px 10px;">Titre de la Note</th>
          <th style="padding:8px 10px;">Cours</th>
          <th style="padding:8px 10px;">Enseignant</th>
          <th style="padding:8px 10px;">Date</th>
        </tr>
      </thead>
      <tbody>
        ${tocRows}
      </tbody>
    </table>
  </div>

  <!-- Toutes les notes individuelles -->
  ${notesSections}

  <script>
    window.onload = () => {
      setTimeout(() => {
        window.print();
      }, 500);
    };
  <\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(fullHtml);
    win.document.close();
  } else {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(fullHtml);
    doc.close();
  }
}

// ── Word import (mammoth UMD) ──────────────────────────────────────────

/**
 * Extract plain text from a .docx file using the mammoth UMD browser build.
 * mammoth does not ship an ESM bundle, so we load it as a classic script.
 * @param {File} file – the .docx File from an <input type="file">
 * @returns {Promise<string>} extracted raw text
 */
export async function importFromWord(file) {
  const mammoth = await _loadMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawValue({ arrayBuffer });
  return result.value;
}
