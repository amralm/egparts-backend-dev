'use strict';

const { supabase } = require('./supabase');
const { createDriverSchema, updateDriverSchema } = require('../schemas/deliveryDriverSchemas');
const logger = require('../utils/logger');

class DeliveryDriverService {
  async listDrivers(storeId) {
    const { data, error } = await supabase
      .from('store_delivery_drivers')
      .select('*')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[deliveryDriverService] listDrivers error:', error.message);
      throw error;
    }
    return data || [];
  }

  async getDriverById(storeId, driverId) {
    const { data, error } = await supabase
      .from('store_delivery_drivers')
      .select('*')
      .eq('id', driverId)
      .eq('store_id', storeId)
      .maybeSingle();

    if (error) {
      logger.error('[deliveryDriverService] getDriverById error:', error.message);
      throw error;
    }
    return data;
  }

  async createDriver(storeId, payload) {
    const parsed = createDriverSchema.parse(payload);
    const { data, error } = await supabase
      .from('store_delivery_drivers')
      .insert([{
        ...parsed,
        store_id: storeId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select('*')
      .single();

    if (error) {
      logger.error('[deliveryDriverService] createDriver error:', error.message);
      throw error;
    }
    return data;
  }

  async updateDriver(storeId, driverId, payload) {
    const parsed = updateDriverSchema.parse(payload);
    const { data, error } = await supabase
      .from('store_delivery_drivers')
      .update({
        ...parsed,
        updated_at: new Date().toISOString()
      })
      .eq('id', driverId)
      .eq('store_id', storeId)
      .select('*')
      .maybeSingle();

    if (error) {
      logger.error('[deliveryDriverService] updateDriver error:', error.message);
      throw error;
    }
    if (!data) {
      const err = new Error('لم يتم العثور على المندوب المطلوب.');
      err.statusCode = 404;
      err.code = 'DRIVER_NOT_FOUND';
      throw err;
    }
    return data;
  }

  async deleteDriver(storeId, driverId) {
    const { error } = await supabase
      .from('store_delivery_drivers')
      .delete()
      .eq('id', driverId)
      .eq('store_id', storeId);

    if (error) {
      logger.error('[deliveryDriverService] deleteDriver error:', error.message);
      throw error;
    }
    return true;
  }
}

module.exports = new DeliveryDriverService();
