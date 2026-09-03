import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { buildWorkbook, buildPdf, range } from '../exports.js';

export const router = Router();
router.use(requireAuth);

const REPORTS = ['reconciliation', 'salesmen', 'bills', 'cancellations', 'shortages', 'cash-rollup', 'collection'];

router.get('/:report', async (req, res, next) => {
  try {
    const report = String(req.params.report);
    if (!REPORTS.includes(report)) return res.status(404).json({ error: `No export called "${report}".` });

    const { from, to } = range(req);
    const salesmanId = req.user.role === 'admin'
      ? (req.query.salesmanId ? Number(req.query.salesmanId) : undefined)
      : req.user.id;

    const format = String(req.query.format || 'xlsx');
    const out = format === 'pdf'
      ? await buildPdf({ report, from, to, salesmanId })
      : await buildWorkbook({ report, from, to, salesmanId });

    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(out.buffer));
  } catch (err) { next(err); }
});
