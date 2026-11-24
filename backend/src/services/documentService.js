const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, HeadingLevel } = require('docx');

function htmlToPlainText(html) {
  return html
    .replace(/<\/(h1|h2|h3|p|div|li)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function generateDocumentFiles({ baseFileName, title, htmlContent }) {
  const outputDir = path.join(__dirname, '..', '..', '..', 'storage', 'documents');
  fs.mkdirSync(outputDir, { recursive: true });

  const plainText = htmlToPlainText(htmlContent);
  const pdfPath = path.join(outputDir, `${baseFileName}.pdf`);
  const docxPath = path.join(outputDir, `${baseFileName}.docx`);

  await new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    stream.on('finish', resolve);
    stream.on('error', reject);

    pdf.pipe(stream);
    pdf.fontSize(18).text(title, { underline: true });
    pdf.moveDown();
    pdf.fontSize(12).text(plainText, { align: 'left' });
    pdf.end();
  });

  const paragraphs = plainText.split('\n').map((line) => new Paragraph(line || ' '));
  const doc = new Document({
    sections: [{ children: [new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }), ...paragraphs] }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buffer);

  return { pdfPath, docxPath };
}

module.exports = { generateDocumentFiles };
