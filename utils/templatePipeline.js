const Handlebars = require('handlebars');
const xss = require('xss');

// Safe instance of Handlebars that doesn't leak context
const SafeHandlebars = Handlebars.create();

// Disable prototype access completely to prevent prototype pollution / RCE
// https://handlebarsjs.com/api-reference/runtime-options.html
// However, since we compile on the server with user input, we must be extra careful.
// We only allow basic operations.

class TemplateValidator {
    static validate(templateString) {
        if (!templateString) return '';
        // Prevent known risky Handlebars constructs like `constructor` or `prototype` access
        if (/__proto__|constructor|prototype|process|require/.test(templateString)) {
            throw new Error('Unsafe expressions detected in template');
        }
        return templateString;
    }
}

class TemplateNormalizer {
    static normalize(templateString) {
        // Strip out dangerous HTML while preserving Handlebars syntax {{}}
        // First, temporarily mask Handlebars expressions
        let counter = 0;
        const expressions = {};
        let masked = templateString.replace(/\{\{[^}]+\}\}/g, (match) => {
            const key = `__HBS_${counter++}__`;
            expressions[key] = match;
            return key;
        });

        // Clean HTML using xss
        masked = xss(masked, {
            whiteList: {
                a: ['href', 'title', 'target', 'style', 'class'],
                b: ['style', 'class'],
                i: ['style', 'class'],
                br: [],
                p: ['style', 'class'],
                div: ['style', 'class'],
                span: ['style', 'class'],
                h1: ['style', 'class'],
                h2: ['style', 'class'],
                h3: ['style', 'class'],
                strong: ['style', 'class'],
                em: ['style', 'class'],
                ul: ['style', 'class'],
                ol: ['style', 'class'],
                li: ['style', 'class'],
                table: ['style', 'class', 'border', 'cellpadding', 'cellspacing', 'width'],
                thead: ['style', 'class'],
                tbody: ['style', 'class'],
                tr: ['style', 'class'],
                th: ['style', 'class', 'width', 'align'],
                td: ['style', 'class', 'width', 'align'],
                img: ['src', 'alt', 'width', 'height', 'style', 'class'],
            },
            stripIgnoreTag: true,
            stripIgnoreTagBody: ['script', 'style'] // prevent inline scripts/styles entirely if from user
        });

        // Unmask
        for (const [key, val] of Object.entries(expressions)) {
            masked = masked.replace(key, val);
        }

        return masked;
    }
}

class TemplateCompiler {
    static compile(normalizedTemplateStr) {
        // Strict Mode requires all variables to exist
        return SafeHandlebars.compile(normalizedTemplateStr, {
            strict: true,
            preventIndent: true
        });
    }
}

class TemplateRenderer {
    static render(compiledTemplate, data) {
        return compiledTemplate(data, {
            allowProtoPropertiesByDefault: false,
            allowProtoMethodsByDefault: false
        });
    }
}

class TemplatePipeline {
    static process(rawTemplateStr, data) {
        if (!rawTemplateStr) return '';
        try {
            const validated = TemplateValidator.validate(rawTemplateStr);
            const normalized = TemplateNormalizer.normalize(validated);
            const compiled = TemplateCompiler.compile(normalized);
            return TemplateRenderer.render(compiled, data);
        } catch (error) {
            console.error('Template Pipeline Error:', error.message);
            // Fallback for safety
            return `Template Error: ${error.message}`;
        }
    }
}

module.exports = {
    SafeHandlebars,
    TemplatePipeline,
    TemplateValidator,
    TemplateNormalizer,
    TemplateCompiler,
    TemplateRenderer
};
