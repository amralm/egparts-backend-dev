const { supabase } = require('./supabase');

class EventBus {
  /**
   * Publish an event to the platform_events table.
   * @param {string} eventType 
   * @param {object} payload 
   */
  static async publish(eventType, payload) {
    try {
      const { storeId, context, ...rest } = payload;
      
      const eventRecord = {
        event_type: eventType,
        payload: {
          storeId,
          details: rest,
          context: {
            ip: context?.ip,
            userAgent: context?.userAgent
          }
        },
        triggered_by: context?.userId || null
      };

      const { error } = await supabase.from('platform_events').insert([eventRecord]);
      
      if (error) {
        console.error(`[EventBus] Error publishing ${eventType}:`, error);
      }
    } catch (err) {
      console.error(`[EventBus] Exception publishing ${eventType}:`, err);
    }
  }
}

module.exports = EventBus;
