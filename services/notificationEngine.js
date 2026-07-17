const Handlebars = require('handlebars');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { supabase } = require('./supabase');
const whatsappService = require('./whatsappService');
const logger = require('../utils/logger');
const { TemplatePipeline, SafeHandlebars } = require('../utils/templatePipeline');

// ============================================================
// Handlebars Custom Helpers
// ============================================================

// formatCurrency helper: e.g. {{formatCurrency amount 'EGP'}}
SafeHandlebars.registerHelper('formatCurrency', function (value, currency) {
  const num = parseFloat(value);
  if (isNaN(num)) return value;
  const curr = typeof currency === 'string' ? currency : 'EGP';
  return num.toLocaleString('ar-EG', { style: 'currency', currency: curr });
});

// formatDate helper: e.g. {{formatDate date}}
SafeHandlebars.registerHelper('formatDate', function (dateVal) {
  if (!dateVal) return '';
  const date = new Date(dateVal);
  if (isNaN(date.getTime())) return dateVal;
  return date.toLocaleDateString('ar-EG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
});

// Case converters
SafeHandlebars.registerHelper('uppercase', function (str) {
  return typeof str === 'string' ? str.toUpperCase() : str;
});

SafeHandlebars.registerHelper('lowercase', function (str) {
  return typeof str === 'string' ? str.toLowerCase() : str;
});

// ============================================================
// Dynamic Mailer Transport Resolver
// ============================================================
async function getMailTransport() {
  // Try to load SMTP config from system_settings first
  try {
    const { data: settings } = await supabase
      .from('system_settings')
      .select('*')
      .in('key', ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from']);

    const config = {};
    if (settings) {
      settings.forEach(s => {
        config[s.key] = s.value;
      });
    }

    const host = config.smtp_host || process.env.SMTP_HOST;
    const port = parseInt(config.smtp_port || process.env.SMTP_PORT || '587', 10);
    const user = config.smtp_user || process.env.SMTP_USER;
    const pass = config.smtp_pass || process.env.SMTP_PASS;
    const from = config.smtp_from || user || process.env.SMTP_FROM || 'no-reply@egparts.store';

    if (host && user && pass) {
      const transport = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
        family: 4
      });
      return { transport, from };
    }
  } catch (err) {
    logger.error('Failed to resolve custom SMTP config:', err.message);
  }

  // Fallback: Create Ethereal mock transport for local testing
  logger.info('[NotificationEngine] Creating mock Ethereal SMTP fallback...');
  const testAccount = await nodemailer.createTestAccount();
  const transport = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass
    }
  });
  return { transport, from: 'no-reply@egparts.store', isMock: true, testAccount };
}

// ============================================================
// Core Rendering & Messaging Engine
// ============================================================

/**
 * Renders a template wrapped inside its layout
 */
async function renderNotification(templateCode, channel, language, variables) {
  // 1. Fetch template
  const { data: template, error: tempErr } = await supabase
    .from('notification_templates')
    .select(`
      *,
      notification_layouts (
        header_html,
        footer_html,
        css
      )
    `)
    .eq('code', templateCode)
    .eq('channel', channel)
    .eq('language', language)
    .eq('is_active', true)
    .maybeSingle();

  if (tempErr || !template) {
    throw new Error(`Active template not found for ${templateCode} [${channel}] [${language}]`);
  }

  const renderedSubject = TemplatePipeline.process(template.subject || '', variables);

  // Compile the body HTML template
  const renderedBodyHtml = TemplatePipeline.process(template.body_html || '', variables);

  // Compile body plain text if available
  let renderedBodyText = '';
  if (template.body_text) {
    renderedBodyText = TemplatePipeline.process(template.body_text, variables);
  }

  // Wrap in layout if it exists and channel is email
  let finalHtml = renderedBodyHtml;
  if (channel === 'email' && template.notification_layouts) {
    const layout = template.notification_layouts;
    const fullLayoutStr = `${layout.header_html || ''}{{{body}}}${layout.footer_html || ''}`;
    
    finalHtml = TemplatePipeline.process(fullLayoutStr, {
      ...variables,
      body: renderedBodyHtml,
      css: layout.css || ''
    });
  }

  return {
    templateId: template.id,
    subject: renderedSubject,
    bodyHtml: finalHtml,
    bodyText: renderedBodyText || renderedBodyHtml.replace(/<[^>]*>/g, ''), // strip tags for text fallback
    channel,
    version: template.version
  };
}

/**
 * Sends notification and records delivery audit log in the background
 */
async function sendNotification({ templateCode, recipient, language = 'ar', variables = {} }) {
  logger.info(`[NotificationEngine] Dispatching event: ${templateCode} to ${recipient}`);
  const startTime = Date.now();

  // 1. Determine active channels configured for this template code
  let activeLanguage = language || 'ar';
  let { data: templates, error: lookupErr } = await supabase
    .from('notification_templates')
    .select('channel')
    .eq('code', templateCode)
    .eq('language', activeLanguage)
    .eq('is_active', true);

  if ((!templates || templates.length === 0) && activeLanguage !== 'en') {
    activeLanguage = 'en';
    const fallback = await supabase
      .from('notification_templates')
      .select('channel')
      .eq('code', templateCode)
      .eq('language', activeLanguage)
      .eq('is_active', true);
    templates = fallback.data;
    lookupErr = fallback.error;
  }

  if (lookupErr || !templates || templates.length === 0) {
    logger.warn(`No active channels configured for template code: ${templateCode}`);
    return [];
  }

  const results = [];

  for (const t of templates) {
    const channel = t.channel;
    let status = 'pending';
    let provider = 'unknown';
    let providerMessageId = null;
    let rendered = null;
    let errorMsg = null;

    try {
      // 2. Render content
      rendered = await renderNotification(templateCode, channel, activeLanguage, variables);
      
      // 3. Deliver based on channel
      if (channel === 'email') {
        const { transport, from, isMock, testAccount } = await getMailTransport();
        provider = isMock ? 'ethereal' : 'smtp';
        
        const mailOptions = {
          from,
          to: recipient,
          subject: rendered.subject,
          html: rendered.bodyHtml,
          text: rendered.bodyText
        };

        const info = await transport.sendMail(mailOptions);
        status = 'sent';
        providerMessageId = info.messageId;

        if (isMock && testAccount) {
          logger.info(`[NotificationEngine] Mock Email URL: ${nodemailer.getTestMessageUrl(info)}`);
        }
      } else if (channel === 'whatsapp') {
        provider = 'baileys';
        // Clean up recipient phone number
        let cleanPhone = recipient.replace(/\D/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '2' + cleanPhone;
        
        const success = await whatsappService.sendMessage(cleanPhone, rendered.bodyText);
        if (success) {
          status = 'sent';
          providerMessageId = `wa_${crypto.randomBytes(8).toString('hex')}`;
        } else {
          status = 'failed';
          errorMsg = 'WhatsApp service failed to dispatch message';
        }
      } else {
        status = 'failed';
        errorMsg = `Channel ${channel} not implemented yet`;
      }
    } catch (err) {
      status = 'failed';
      errorMsg = err.message;
      logger.error(`[NotificationEngine] Delivery failed for ${channel} template ${templateCode}:`, err);
    }

    const duration = Date.now() - startTime;

    // 4. Log in notification_history
    try {
      await supabase
        .from('notification_history')
        .insert([{
          template_id: rendered ? rendered.templateId : null,
          recipient,
          channel,
          status,
          provider,
          provider_message_id: providerMessageId,
          rendered_subject: rendered ? rendered.subject : null,
          rendered_body: rendered ? (channel === 'email' ? rendered.bodyHtml : rendered.bodyText) : null,
          error_message: errorMsg,
          duration_ms: duration,
          sent_at: new Date().toISOString()
        }]);
    } catch (dbErr) {
      logger.error('[NotificationEngine] Failed to save notification audit log:', dbErr.message);
    }

    results.push({ channel, status, providerMessageId, errorMsg });
  }

  return results;
}

module.exports = {
  renderNotification,
  sendNotification
};
