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
import { formatDate } from './i18n.js';

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
    lines.push('## Sijesyon IA (sa pwofesè a souzantann)');
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
  return {
    template: c.template || 'classic',
    university: c.university || profile?.university || 'Inivèsite / Université',
    faculty: c.faculty || profile?.faculty?.name_fr || profile?.faculty?.name_ht || 'Fakilte / Faculté',
    course: c.course || course?.name || 'Kou / Cours',
    professor: c.professor || course?.professor || '',
    title: assignment.title || 'Devwa / Travail académique',
    student: c.student || profile?.full_name || 'Etidyan / Étudiant',
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
    doc.text(`Pwofesè / Professeur : ${meta.professor}`, xAnchor, 86, alignOpt);
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
  doc.text(`Etidyan / Étudiant : ${meta.student}`, xAnchor, infoY, alignOpt);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(91, 102, 128);
  if (meta.level) doc.text(`Nivo / Niveau : ${meta.level}`, xAnchor, infoY + 8, alignOpt);
  doc.text(`Dat / Date : ${meta.date}`, xAnchor, infoY + 16, alignOpt);

  // ---- CONTENU ET TABLE DES MATIÈRES ----
  const blocks = parseHtmlBlocks(assignment.content_html || '');
  const headings = blocks.filter((b) => b.kind === 'h');

  if (headings.length) {
    doc.addPage();
    let ty = 30;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(27, 42, 74);
    doc.text('Tab matyè / Table des matières', margin, ty);
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
          children: [new TextRun({ text: `Pwofesè / Professeur : ${meta.professor}`, size: 22, color: '5B6680' })],
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
      children: [new TextRun({ text: `Etidyan / Étudiant : ${meta.student}`, bold: true, size: 24, color: '1B2A4A' })],
      spacing: { after: 100 },
    }),
    ...(meta.level
      ? [new Paragraph({ alignment: align, children: [new TextRun({ text: `Nivo / Niveau : ${meta.level}`, size: 22, color: '5B6680' })], spacing: { after: 100 } })]
      : []),
    new Paragraph({
      alignment: align,
      children: [new TextRun({ text: `Dat / Date : ${meta.date}`, size: 22, color: '5B6680' })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];

  const blocks = parseHtmlBlocks(assignment.content_html || '');
  const headings = blocks.filter((b) => b.kind === 'h');
  const bodyChildren = [];

  if (headings.length) {
    bodyChildren.push(new Paragraph({ text: 'Tab matyè / Table des matières', heading: HeadingLevel.HEADING_1, spacing: { after: 160 } }));
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
    children.push(new Paragraph({ text: 'Devwa', heading: HeadingLevel.HEADING_2 }));
    for (const item of String(note.homework).split(/\n/).filter(Boolean)) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: item.trim() })], bullet: { level: 0 } }),
      );
    }
  }

  if (note.corrections && String(note.corrections).trim()) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ text: 'Koreksyon IA', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: String(note.corrections).trim() }));
  }

  if (note.research_topics && String(note.research_topics).trim()) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ text: 'Sijè pou rechèche', heading: HeadingLevel.HEADING_2 }));
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
      children.push(new Paragraph({ text: 'Devwa', heading: HeadingLevel.HEADING_2 }));
      for (const item of String(note.homework).split(/\n/).filter(Boolean)) {
        children.push(new Paragraph({ children: [new TextRun({ text: item.trim() })], bullet: { level: 0 } }));
      }
    }

    if (note.corrections && String(note.corrections).trim()) {
      children.push(new Paragraph({ text: '' }));
      children.push(new Paragraph({ text: 'Koreksyon IA', heading: HeadingLevel.HEADING_2 }));
      children.push(new Paragraph({ text: String(note.corrections).trim() }));
    }

    if (note.research_topics && String(note.research_topics).trim()) {
      children.push(new Paragraph({ text: '' }));
      children.push(new Paragraph({ text: 'Sijè pou rechèche', heading: HeadingLevel.HEADING_2 }));
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
    extrasHtml += `<h2>Devwa</h2><ul>${items}</ul>`;
  }
  if (note.corrections && String(note.corrections).trim()) {
    extrasHtml += `<h2>Koreksyon IA</h2><p>${_esc(String(note.corrections).trim())}</p>`;
  }
  if (note.research_topics && String(note.research_topics).trim()) {
    const topics = String(note.research_topics).split(/\n/).filter(Boolean)
      .map((t) => `<li>${_esc(t.trim())}</li>`).join('');
    extrasHtml += `<h2>Sijè pou rechèche</h2><ul>${topics}</ul>`;
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
