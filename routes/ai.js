const express = require('express');
const router = express.Router();
const { verifyUser } = require('../middleware/auth');
const { requireEntitlement } = require('../server/kernel/policy/policyMiddleware');
const { FEATURES } = require('../server/kernel/core/FeatureRegistry');
const { supabase } = require('../services/supabase');
const aiService = require('../services/aiService');
const toolRegistry = require('../services/toolRegistry');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const EntitlementFacade = require('../server/kernel/policy/EntitlementFacade');
const cacheProvider = require('../services/cacheProvider');
const logger = require('../utils/logger');

/**
 * Chat with EGParts Copilot (AI Advisor)
 */
router.post('/consultant', 
  verifyUser, 
  requireEntitlement([
    { feature: FEATURES.AI_MESSAGES_DAILY, consume: 1 },
    { feature: FEATURES.AI_REQUESTS_MONTHLY, consume: 1 }
  ]),
  async (req, res) => {
  const { message, currentRoute, history } = req.body;
  const storeId = req.store?.id;
  const userId = req.user?.sub;

  if (!storeId) {
    return res.status(400).json({ error: 'Store context required' });
  }
  if (!message) {
    return res.status(400).json({ error: 'Message payload required' });
  }

  // Clear tenant usage cache so UI reflects new limits (could be moved to event listener later)
  await subscriptionLimitService.clearStoreCache(storeId);

  // 3. Query Cache validation
  const cacheKey = `copilot_chat:${storeId}:${message}:${currentRoute}`;
  const cached = await cacheProvider.get(cacheKey);
  if (cached) {
    // If cached, we didn't actually hit the AI. We should refund both policies.
    await EntitlementFacade.refund(storeId, FEATURES.COPILOT_MONTHLY_MESSAGES, 1, { source: 'CacheHit' });
    await EntitlementFacade.refund(storeId, FEATURES.COPILOT_DAILY_MESSAGES, 1, { source: 'CacheHit' });
    return res.json(cached);
  }

  try {
    // 4. Setup or retrieve AI Session
    const sessionId = req.body.sessionId || `session_${Date.now()}`;
    const { data: session } = await supabase
      .from('ai_sessions')
      .select('id, actions_suggested')
      .eq('store_id', storeId)
      .eq('id', sessionId)
      .maybeSingle();

    if (!session) {
      await supabase.from('ai_sessions').insert({
        id: sessionId,
        store_id: storeId,
        actions_suggested: 0,
        actions_accepted: 0
      });
    }

    // 5. Generate AI Agent response
    const aiResponse = await aiService.generateCopilotResponse(storeId, userId, message, currentRoute, history, {
      correlationId: req.correlationId || null,
      ipAddress: req.ip || req.socket?.remoteAddress || '',
      userAgent: req.headers['user-agent'] || ''
    });

    // Update Session actions counter
    if (aiResponse.actions && aiResponse.actions.length > 0) {
      await supabase
        .from('ai_sessions')
        .update({
          actions_suggested: (session?.actions_suggested || 0) + aiResponse.actions.length,
          last_active: new Date().toISOString()
        })
        .eq('id', sessionId);
    }

    // Cache successful responses for 10 minutes
    await cacheProvider.set(cacheKey, aiResponse, 600);

    res.json(aiResponse);

  } catch (err) {
    logger.error('Failed to run AI consultant query:', err.message);
    // Rollback limits on failure
    await EntitlementFacade.refund(storeId, FEATURES.AI_MESSAGES_DAILY, 1, { source: 'ErrorRollback' });
    await EntitlementFacade.refund(storeId, FEATURES.AI_REQUESTS_MONTHLY, 1, { source: 'ErrorRollback' });
    res.status(500).json({ error: 'Failed to communicate with AI partner' });
  }
});

/**
 * Read-only AI tool manifests available to the current tenant.
 */
router.get('/tools', verifyUser, async (req, res) => {
  const storeId = req.store?.id;
  if (!storeId) return res.status(400).json({ error: 'Store context required' });

  try {
    const { data: store, error } = await supabase
      .from('stores')
      .select('business_type')
      .eq('id', storeId)
      .maybeSingle();

    if (error) throw error;

    res.json({
      tools: toolRegistry.getAvailableTools(store?.business_type || 'general')
    });
  } catch (err) {
    logger.error('Failed to load AI tool registry:', err.message);
    res.status(500).json({ error: 'Failed to load AI tool registry' });
  }
});

/**
 * Approve and Execute a drafted AI Action
 */
router.post('/action-queue/approve', verifyUser, async (req, res) => {
  const { actionType, payload, sessionId } = req.body;
  const storeId = req.store?.id;

  if (!storeId || !actionType || !payload) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    // Create an action queue row in draft state, then immediately execute it!
    const { data: actionRow, error: queueErr } = await supabase
      .from('ai_action_queue')
      .insert({
        store_id: storeId,
        action_type: actionType,
        payload: payload,
        status: 'approved'
      })
      .select('id')
      .single();

    if (queueErr) throw queueErr;

    // Execution Router
    if (actionType === 'create_coupon') {
      const limitCheck = await subscriptionLimitService.checkFeatureLimit(storeId, 'coupons', 0);
      if (!limitCheck.allowed) {
        await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
        return res.status(403).json({ error: 'خطة الاشتراك الحالية لا تسمح بإنشاء كوبونات خصم. يرجى ترقية الباقة.' });
      }

      const couponCode = payload.code || `PROMO_${Date.now()}`;
      
      // Perform insert in coupons table
      const { error: insertErr } = await supabase
        .from('coupons')
        .insert({
          store_id: storeId,
          code: couponCode.trim().toUpperCase(),
          discount_percentage: Number(payload.discount_percentage || 10),
          is_active: true,
          expiry_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days default
        });

      if (insertErr) {
        await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
        return res.status(400).json({ error: insertErr.message });
      }
    } else if (actionType === 'create_description') {
      if (payload.productId && payload.description) {
        // Fetch current specs to keep existing key-values
        const { data: product } = await supabase
          .from('products')
          .select('specs')
          .eq('id', payload.productId)
          .eq('store_id', storeId)
          .maybeSingle();

        const updatedSpecs = {
          ...(product?.specs || {}),
          "الوصف": payload.description
        };

        const { error: updateErr } = await supabase
          .from('products')
          .update({ specs: updatedSpecs })
          .eq('id', payload.productId)
          .eq('store_id', storeId);

        if (updateErr) {
          await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
          return res.status(400).json({ error: updateErr.message });
        }
      }
    } else if (actionType === 'update_settings') {
      const allowedKeys = ['primary_color', 'secondary_color', 'store_name', 'support_hours', 'whatsapp_number', 'facebook_url', 'instagram_url', 'tiktok_url'];
      const updateData = {};
      
      for (const key of allowedKeys) {
        if (payload[key] !== undefined) {
          updateData[key] = payload[key];
        }
      }

      if (Object.keys(updateData).length > 0) {
        const { error: updateErr } = await supabase
          .from('site_settings')
          .update(updateData)
          .eq('store_id', storeId);

        if (updateErr) {
          await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
          return res.status(400).json({ error: updateErr.message });
        }
      }
    } else if (actionType === 'update_theme_colors') {
      const { data: currentSettings } = await supabase
        .from('site_settings')
        .select('theme_colors')
        .eq('store_id', storeId)
        .maybeSingle();
        
      const mergedColors = { ...(currentSettings?.theme_colors || {}), ...payload };
      
      const { error: updateErr } = await supabase
        .from('site_settings')
        .update({ theme_colors: mergedColors })
        .eq('store_id', storeId);

      if (updateErr) {
        await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
        return res.status(400).json({ error: updateErr.message });
      }
    } else if (actionType === 'update_stock') {
      if (payload.productId && typeof payload.new_stock === 'number') {
        const { error: updateErr } = await supabase
          .from('products')
          .update({ stock: payload.new_stock })
          .eq('id', payload.productId)
          .eq('store_id', storeId);
        
        if (updateErr) {
          await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
          return res.status(400).json({ error: updateErr.message });
        }
      }
    } else if (actionType === 'update_order_status') {
      if (payload.orderId && payload.status) {
        const { error: updateErr } = await supabase
          .from('orders')
          .update({ status: payload.status })
          .eq('id', payload.orderId)
          .eq('store_id', storeId);

        if (updateErr) {
          await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
          return res.status(400).json({ error: updateErr.message });
        }
      }
    } else if (actionType === 'delete_product') {
      if (payload.productId) {
        const { error: deleteErr } = await supabase
          .from('products')
          .delete()
          .eq('id', payload.productId)
          .eq('store_id', storeId);

        if (deleteErr) {
          await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
          return res.status(400).json({ error: deleteErr.message });
        }
      }
    } else if (actionType === 'send_whatsapp_campaign') {
      console.log(`[WhatsApp Mock] Sending to ${payload.segment}. Msg: ${payload.message}`);
    } else if (actionType === 'issue_refund') {
      if (payload.orderId) {
        const { error: updateErr } = await supabase
          .from('orders')
          .update({ payment_status: 'refunded' })
          .eq('id', payload.orderId)
          .eq('store_id', storeId);

        if (updateErr) {
          await supabase.from('ai_action_queue').update({ status: 'failed' }).eq('id', actionRow.id);
          return res.status(400).json({ error: updateErr.message });
        }
      }
    } else if (actionType === 'create_product') {
      if (payload.name && payload.price !== undefined) {
        const { error: insertErr } = await supabase
          .from('products')
          .insert({
            store_id: storeId,
            name: payload.name,
            price: payload.price,
            stock: payload.stock || 0,
            category_id: payload.category_id || null,
            is_active: true
          });
        if (insertErr) throw insertErr;
      }
    } else if (actionType === 'update_product_price') {
      if (payload.productId && payload.price !== undefined) {
        const { error: updateErr } = await supabase
          .from('products')
          .update({ price: payload.price, compare_at_price: payload.compare_at_price || null })
          .eq('id', payload.productId)
          .eq('store_id', storeId);
        if (updateErr) throw updateErr;
      }
    } else if (actionType === 'toggle_product_visibility') {
      if (payload.productId && payload.is_active !== undefined) {
        const { error: updateErr } = await supabase
          .from('products')
          .update({ is_active: payload.is_active })
          .eq('id', payload.productId)
          .eq('store_id', storeId);
        if (updateErr) throw updateErr;
      }
    } else if (actionType === 'create_category') {
      if (payload.name && payload.slug) {
        const { error: insertErr } = await supabase
          .from('categories')
          .insert({
            store_id: storeId,
            name: payload.name,
            slug: payload.slug,
            is_active: true
          });
        if (insertErr) throw insertErr;
      }
    } else if (actionType === 'toggle_maintenance_mode') {
      if (payload.enabled !== undefined) {
        const { error: updateErr } = await supabase
          .from('site_settings')
          .update({ maintenance_mode: String(payload.enabled) })
          .eq('store_id', storeId);
        if (updateErr) throw updateErr;
      }
    } else if (actionType === 'update_shipping_fee') {
      if (payload.fee !== undefined) {
        const { error: updateErr } = await supabase
          .from('site_settings')
          .update({ flat_shipping_fee: payload.fee })
          .eq('store_id', storeId);
        if (updateErr) throw updateErr;
      }
    } else if (actionType === 'ban_customer') {
      if (payload.customerId && payload.is_banned !== undefined) {
        const { error: updateErr } = await supabase
          .from('customers')
          .update({ is_banned: payload.is_banned })
          .eq('id', payload.customerId)
          .eq('store_id', storeId);
        if (updateErr) throw updateErr;
      }
    } else if (actionType === 'update_store_seo') {
      if (payload.seo_title || payload.seo_description) {
        const { error: updateErr } = await supabase
          .from('site_settings')
          .update({
            seo_title: payload.seo_title,
            seo_description: payload.seo_description
          })
          .eq('store_id', storeId);
        if (updateErr) throw updateErr;
      }
    } else {
      return res.status(400).json({ error: `Unsupported action type: ${actionType}` });
    }

    // Mark as completed
    await supabase
      .from('ai_action_queue')
      .update({
        status: 'completed',
        executed_at: new Date().toISOString()
      })
      .eq('id', actionRow.id);

    // Track in recommendation feedback loop
    await supabase.from('ai_recommendation_feedback').insert({
      store_id: storeId,
      recommendation_id: sessionId || 'feedback_id',
      recommendation_type: actionType,
      action_state: 'accepted'
    });

    // Update session metrics
    if (sessionId) {
      const { data: session } = await supabase
        .from('ai_sessions')
        .select('actions_accepted')
        .eq('id', sessionId)
        .maybeSingle();

      if (session) {
        await supabase
          .from('ai_sessions')
          .update({
            actions_accepted: (session.actions_accepted || 0) + 1,
            saved_time_minutes: (session.saved_time_minutes || 0) + 5 // assume 5 minutes saved per action!
          })
          .eq('id', sessionId);
      }
    }

    res.json({ success: true, actionId: actionRow.id });

  } catch (err) {
    logger.error('Failed to execute AI draft action:', err.message);
    res.status(500).json({ error: 'Action execution failed' });
  }
});

/**
 * Get pre-computed Sunday Weekly Review summary
 */
router.get('/weekly-review', verifyUser, async (req, res) => {
  const storeId = req.store?.id;
  if (!storeId) return res.status(400).json({ error: 'Store context required' });

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [
      { count: lowStock },
      { count: activeProducts },
      { count: currentWeekOrders },
      { count: previousWeekOrders },
      { count: missingImagesCount },
      uploadLimit
    ] = await Promise.all([
      supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', storeId).eq('is_deleted', false).eq('stock_quantity', 0),
      supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', storeId).eq('is_deleted', false).eq('is_active', true),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', storeId).gt('created_at', sevenDaysAgo.toISOString()),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', storeId).gt('created_at', fourteenDaysAgo.toISOString()).lte('created_at', sevenDaysAgo.toISOString()),
      supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', storeId).eq('is_deleted', false).is('image', null),
      subscriptionLimitService.checkFeatureLimit(storeId, 'uploads', 0)
    ]);

    let salesChangePct = 0;
    if (previousWeekOrders > 0) {
      salesChangePct = Math.round(((currentWeekOrders - previousWeekOrders) / previousWeekOrders) * 100);
    } else if (currentWeekOrders > 0) {
      salesChangePct = 100;
    }

    let storageUsagePct = 0;
    if (uploadLimit && uploadLimit.limit && uploadLimit.limit > 0) {
      storageUsagePct = Math.min(100, Math.round(((uploadLimit.usage || 0) / uploadLimit.limit) * 100));
    }

    const reviewJSON = {
      salesChangePct,
      outOfStockCount: lowStock || 0,
      missingImagesCount: missingImagesCount || 0,
      storageUsagePct,
      growthTip: currentWeekOrders > 0 ? "أداء ممتاز! فكّر في إطلاق عروض جديدة لمواصلة النمو." : "قم بتفعيل كوبون خصم لزيادة المبيعات وعروض عطلة نهاية الأسبوع!"
    };

    res.json(reviewJSON);
  } catch (err) {
    logger.error('Failed to load weekly review:', err.message);
    res.status(500).json({ error: 'Failed to load weekly review' });
  }
});

module.exports = router;
