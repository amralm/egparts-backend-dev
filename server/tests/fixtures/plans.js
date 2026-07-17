const { FEATURES } = require('../../kernel/core/FeatureRegistry');
const { PlanBuilder } = require('../builders');

const basicPlan = new PlanBuilder()
    .withName('Basic Plan')
    .withEntitlement(FEATURES.MAX_ITEMS, 100)
    .withEntitlement(FEATURES.MAX_EMPLOYEES, 2)
    .withEntitlement(FEATURES.MAX_BRANCHES, 1)
    .withEntitlement(FEATURES.ENABLE_WHATSAPP, 0) // Boolean false
    .build();

const professionalPlan = new PlanBuilder()
    .withName('Professional Plan')
    .withEntitlement(FEATURES.MAX_ITEMS, 1000)
    .withEntitlement(FEATURES.MAX_EMPLOYEES, 10)
    .withEntitlement(FEATURES.MAX_BRANCHES, 3)
    .withEntitlement(FEATURES.ENABLE_WHATSAPP, 1) // Boolean true
    .withEntitlement(FEATURES.COPILOT_MESSAGES_DAILY, 50)
    .build();

const enterprisePlan = new PlanBuilder()
    .withName('Enterprise Plan')
    .withEntitlement(FEATURES.MAX_ITEMS, 999999) // Infinite
    .withEntitlement(FEATURES.MAX_EMPLOYEES, 50)
    .withEntitlement(FEATURES.MAX_BRANCHES, 10)
    .withEntitlement(FEATURES.ENABLE_WHATSAPP, 1) // Boolean true
    .withEntitlement(FEATURES.COPILOT_MESSAGES_DAILY, 500)
    .build();

const trialPlan = new PlanBuilder()
    .withName('Trial Plan (14 Days)')
    .withEntitlement(FEATURES.MAX_ITEMS, 50)
    .withEntitlement(FEATURES.MAX_EMPLOYEES, 1)
    .withEntitlement(FEATURES.MAX_BRANCHES, 1)
    .withEntitlement(FEATURES.ENABLE_WHATSAPP, 0)
    .withEntitlement(FEATURES.COPILOT_MESSAGES_DAILY, 5)
    .build();

module.exports = {
    basicPlan,
    professionalPlan,
    enterprisePlan,
    trialPlan
};
