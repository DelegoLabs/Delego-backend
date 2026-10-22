/*
 * PDF invoice renderer for the signed invoice generation worker.
 *
 * Renders a tax invoice to a PDF buffer using pdfmake. The renderer is
 * pure: it takes the job payload and invoice metadata and returns the bytes.
 * Signing and storage happen in the worker, not here.
 */

import PdfPrinter from "pdfmake";

import type { InvoiceGenerationJobData } from "./types.js";

export interface RenderInvoiceInput {
  job: InvoiceGenerationJobData;
  invoiceNumber: string;
  generatedAt: Date;
  /** Optional merchant display name printed on the invoice. */
  merchantName?: string;
}

const COLOR_HEAD = "#1f2937";
const COLOR_MUTED = "#6c757d";
const COLOR_RULE = "#d1d5db";

/**
 * Render the invoice to a PDF buffer. Throws if the job contains no line
 * items or if any amount is not a valid decimal string.
 */
export async function renderInvoicePdf(input: RenderInvoiceInput): Promise<Buffer> {
  const { job, invoiceNumber, generatedAt, merchantName } = input;

  if (!job.lineItems || job.lineItems.length === 0) {
    throw new Error(`Cannot render invoice ${invoiceNumber}: no line items`);
  }

  const currency = normaliseCurrency(job.currency);
  const lineRows = job.lineItems.map((line, index) => {
    const qty = assertQuantity(line.qty, index);
    const unitPrice = assertAmount(line.unitPrice, `lineItems[${index}].unitPrice`);
    const tax = assertAmount(line.tax, `lineItems[${index}].tax`);
    const net = qty * unitPrice;
    return {
      description: line.description,
      qty,
      unitPrice,
      tax,
      net,
    };
  });

  const totalAmount = assertAmount(job.totalAmount, "totalAmount");
  const computedNet = lineRows.reduce((sum, row) => sum + row.net, 0);
  const computedTax = lineRows.reduce((sum, row) => sum + row.tax, 0);

  const docDefinition: Record<string, unknown> = {
    pageSize: "A4",
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { fontSize: 10, color: "#111827" },
    content: [
      {
        columns: [
          { text: "TAX INVOICE", style: "title" },
          {
            align: "right",
            stack: [
              { text: `Invoice #${invoiceNumber}`, style: "meta" },
              { text: `Issued ${formatDate(generatedAt)}`, style: "meta" },
              { text: `Order ${job.orderId}`, style: "meta" },
            ],
          },
        ],
      },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: COLOR_RULE }] },
      {
        columns: [
          {
            stack: [
              { text: "Seller", style: "sectionLabel" },
              { text: merchantName ?? "Merchant", style: "sectionValue" },
              { text: `Tax ID: ${job.merchantTaxId}`, style: "meta" },
            ],
          },
          {
            stack: [
              { text: "Bill To", style: "sectionLabel" },
              { text: job.buyerName, style: "sectionValue" },
            ],
          },
        ],
        columnGap: 24,
      },
      {
        table: {
          headerRows: 1,
          widths: ["*", 40, 80, 80, 80],
          body: [
            [
              { text: "Description", style: "tableHeader" },
              { text: "Qty", style: "tableHeader", align: "right" },
              { text: "Unit price", style: "tableHeader", align: "right" },
              { text: "Tax", style: "tableHeader", align: "right" },
              { text: "Line total", style: "tableHeader", align: "right" },
            ],
            ...lineRows.map((row) => [
              { text: row.description },
              { text: String(row.qty), align: "right" },
              { text: formatMoney(row.unitPrice, currency), align: "right" },
              { text: formatMoney(row.tax, currency), align: "right" },
              { text: formatMoney(row.net + row.tax, currency), align: "right" },
            ]),
          ],
        },
        layout: {
          hLineColor: () => COLOR_RULE,
          vLineColor: () => COLOR_RULE,
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          paddingLeft: () => 6,
          paddingRight: () => 6,
          paddingTop: () => 4,
          paddingBottom: () => 4,
        },
      },
      {
        columns: [
          { text: "" },
          {
            width: 200,
            table: {
              widths: ["*", "*"],
              body: [
                [
                  { text: "Subtotal", style: "totalLabel" },
                  { text: formatMoney(computedNet, currency), align: "right" },
                ],
                [
                  { text: "Tax", style: "totalLabel" },
                  { text: formatMoney(computedTax, currency), align: "right" },
                ],
                [
                  { text: "Total", style: "totalLabelBold" },
                  { text: formatMoney(totalAmount, currency), align: "right", style: "totalValue" },
                ],
              ],
              layout: "noBorders",
            },
          },
        ],
      },
      {
        text: "This invoice is immutable and tamper-evident. The digital signature is attached to the stored PDF and can be verified against the platform public key.",
        style: "footer",
        margin: [0, 24, 0, 0],
      },
    ],
    styles: {
      title: { fontSize: 22, bold: true, color: COLOR_HEAD },
      meta: { fontSize: 9, color: COLOR_MUTED },
      sectionLabel: { fontSize: 9, bold: true, color: COLOR_MUTED, marginBottom: 2 },
      sectionValue: { fontSize: 11, bold: true },
      tableHeader: { bold: true, color: COLOR_HEAD, fontSize: 9 },
      totalLabel: { fontSize: 10, color: COLOR_MUTED },
      totalLabelBold: { fontSize: 11, bold: true, color: COLOR_HEAD },
      totalValue: { fontSize: 11, bold: true },
      footer: { fontSize: 8, color: COLOR_MUTED, italics: true },
    },
  };

  const printer = new PdfPrinter(docDefinition as PdfPrinter.TDocumentDefinition);
  return await printer.getBuffer();
}

function normaliseCurrency(currency: string): string {
  if (typeof currency !== "string" || !currency.trim()) {
    throw new Error("Invoice currency is required");
  }
  return currency.trim().toUpperCase();
}

function assertQuantity(value: number, index: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid quantity at lineItems[${index}]: ${String(value)}`);
  }
  return value;
}

/** Parses a decimal amount string into a number, rejecting non-numeric input. */
function assertAmount(value: string, field: string): number {
  const parsed = Number(value);
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(parsed)) {
    throw new Error(`Invalid amount for ${field}: ${String(value)}`);
  }
  return parsed;
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
