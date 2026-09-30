import { z } from 'zod';

const oid = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const idParam = z.object({ id: oid });
export const objectId = oid;

const str = (max = 200) => z.string().trim().max(max);
export const pageQuery = { page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).optional() };
export const rangeQuery = {
  range: z.enum(['today', 'yesterday', 'last7', 'last30', 'custom']).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
};
// Extra query keys (status, provider, tag, …) are allowed but only as short strings or string lists: never nested objects.
const scalar = z.union([z.string().max(200), z.array(z.string().max(200)).max(20)]);
const loose = (shape) => z.object(shape).catchall(scalar);

export const listQuery = loose({ ...pageQuery, ...rangeQuery, q: str(100).optional() });

/* customers */
export const customerCreate = z.object({
  firstName: str(80).optional(), lastName: str(80).optional(),
  phone: str(30).optional(), email: str(200).optional(), company: str(120).optional(),
  tags: z.array(str(40)).max(30).optional(), status: z.enum(['lead', 'active', 'inactive', 'blocked']).optional(),
  source: z.enum(['WhatsApp', 'Email', 'Payment', 'Manual', 'API']).optional(), note: str(2000).optional(),
}).strict();
export const customerUpdate = z.object({
  firstName: str(80), lastName: str(80), phone: str(30).or(z.literal('')), email: str(200).or(z.literal('')), company: str(120),
  status: z.enum(['lead', 'active', 'inactive', 'blocked']), assignedTo: oid.nullable(),
}).partial().strict();
export const noteBody = z.object({ text: str(2000).min(1) }).strict();
export const tagsBody = z.object({ tags: z.array(str(40).min(1)).min(1).max(20) }).strict();

/* whatsapp */
const media = z.object({ url: z.string().url().max(2000), caption: str(1000).optional(), filename: str(200).optional() });
export const waSend = z.object({
  conversationId: oid.optional(), customerId: oid.optional(), phone: str(30).optional(),
  account: z.string().regex(/^msg91(_[a-z0-9]{4,16})?$/).optional(), // which WhatsApp number sends it (default: the number the customer wrote to)
  type: z.enum(['text', 'template', 'image', 'video', 'audio', 'document']).default('text'),
  text: str(4096).optional(), media: media.optional(), templateId: oid.optional(),
  template: z.object({ name: str(200), language: str(20).optional(), variables: z.array(z.union([z.string(), z.number()])).max(30).optional() }).optional(),
}).strict().superRefine((v, ctx) => {
  if (!v.conversationId && !v.customerId && !v.phone) ctx.addIssue({ code: 'custom', message: 'Provide conversationId, customerId or phone', path: ['phone'] });
  if (v.type === 'text' && !v.text) ctx.addIssue({ code: 'custom', message: 'Message text is required', path: ['text'] });
  if (v.type === 'template' && !v.templateId && !v.template?.name) ctx.addIssue({ code: 'custom', message: 'Choose a template', path: ['template'] });
  if (['image', 'video', 'audio', 'document'].includes(v.type) && !v.media?.url) ctx.addIssue({ code: 'custom', message: 'Media URL is required', path: ['media'] });
});
export const convPatch = z.object({ status: z.enum(['open', 'pending', 'resolved', 'archived']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() }).strict();
export const assignBody = z.object({ userId: oid.nullable() }).strict();
export const tagBody = z.object({ tag: str(40).min(1) }).strict();
export const waTemplate = z.object({
  name: str(200).min(1), language: str(20).default('en'), namespace: str(200).optional(),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION', 'OTHER']).optional(), bodyText: str(1024).optional(),
  variableCount: z.number().int().min(0).max(30).optional(), enabled: z.boolean().optional(),
}).strict();

/* email */
const addr = z.union([z.string().email().max(200), z.object({ email: z.string().email().max(200), name: str(120).optional() })]);
export const emailSend = z.object({
  to: z.array(addr).min(1).max(50), cc: z.array(addr).max(50).optional(), bcc: z.array(addr).max(50).optional(),
  subject: str(300).optional(), htmlContent: z.string().max(500_000).optional(), textContent: z.string().max(200_000).optional(),
  templateId: oid.optional(), variables: z.record(z.union([z.string(), z.number()])).optional(), customerId: oid.optional(),
  senderEmail: z.string().email().optional(), senderName: str(120).optional(),
  account: z.string().regex(/^(auto|1|2|brevo2?|brevo_[a-z0-9]{4,16})$/).optional(), // which Brevo account sends this email
  attachments: z.array(z.object({ name: str(200).min(1), contentBase64: z.string().min(1).max(10_000_000) })).max(5).optional(),
}).strict().superRefine((v, ctx) => {
  if (!v.templateId && !v.subject) ctx.addIssue({ code: 'custom', message: 'Subject is required', path: ['subject'] });
  if (!v.templateId && !v.htmlContent && !v.textContent) ctx.addIssue({ code: 'custom', message: 'Add HTML or text content', path: ['htmlContent'] });
});
export const emailTemplate = z.object({
  name: str(120).min(1), subject: str(300).min(1), htmlContent: z.string().max(500_000).default(''), textContent: z.string().max(200_000).optional(), enabled: z.boolean().optional(),
}).strict();
export const emailTemplatePatch = emailTemplate.partial().strict();
export const emailContactPatch = z.object({ name: str(120), subscribed: z.boolean(), blocked: z.boolean() }).partial().strict();

/* payments */
export const orderCreate = z.object({
  amount: z.number().positive().max(10_000_000), currency: z.string().length(3).optional(), receipt: str(40).optional(), description: str(250).optional(),
  customerId: oid.optional(), customer: z.object({ firstName: str(80).optional(), lastName: str(80).optional(), name: str(160).optional(), phone: str(30).optional(), email: str(200).optional() }).optional(),
  account: z.string().regex(/^razorpay(_[a-z0-9]{4,16})?$/).optional(), // which Razorpay account creates the order
  notes: z.record(z.union([z.string(), z.number()])).optional(),
}).strict();
export const paymentVerify = z.object({ orderId: str(60).min(1), paymentId: str(60).min(1), signature: str(200).min(1) }).strict();
export const refundBody = z.object({ amount: z.number().positive().optional(), reason: str(200).optional(), speed: z.enum(['normal', 'optimum']).optional() }).strict();

/* telegram */
export const routeCreate = z.object({
  name: str(80).min(1), chatId: str(64).min(1), eventTypes: z.array(str(60)).min(1).max(60), enabled: z.boolean().optional(), description: str(300).optional(),
  account: z.string().regex(/^telegram(_[a-z0-9]{4,16})?$/).nullable().optional(), // which bot sends to this chat (null = default bot)
}).strict();
export const routePatch = routeCreate.partial().strict();
export const togglesBody = z.record(z.boolean());

/* integrations */
export const integrationSave = z.object({ values: z.record(z.union([z.string(), z.number(), z.null()])).default({}), clear: z.array(str(60)).optional(), force: z.boolean().optional() }).strict();
export const providerParam = z.object({ provider: z.string().regex(/^(mongodb|system|msg91|brevo|brevo2|razorpay|telegram|(msg91|brevo|razorpay|telegram)_[a-z0-9]{4,16})$/, 'Unknown integration') });
export const accountCreate = z.object({
  type: z.enum(['msg91', 'brevo', 'razorpay', 'telegram']), label: str(80).optional(),
  values: z.record(z.union([z.string(), z.number(), z.null()])).default({}), force: z.boolean().optional(),
}).strict();
export const accountPatch = z.object({ label: z.string().max(80).optional(), isDefault: z.boolean().optional() }).strict();

/* settings */
export const sectionParam = z.object({ section: z.enum(['general', 'whatsapp', 'email', 'payments', 'telegram', 'security']) });
