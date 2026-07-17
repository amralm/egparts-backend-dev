class IConfigurationProvider {
    /**
     * Get a configuration value by key
     * @param {string} key 
     * @param {*} defaultValue 
     */
    get(key, defaultValue = null) { throw new Error('Not implemented'); }
    
    /**
     * Check if a configuration key exists
     * @param {string} key 
     */
    has(key) { throw new Error('Not implemented'); }
}

module.exports = IConfigurationProvider;
