/*
 * No Fear, No Hunger for Fear & Hunger 1 / MattieFM Mod Manager
 * v1.0 (language-independent hunger event fallback)
 *
 * Blocks passive HUNGER growth from named HUNGER_of_* common events.
 * Blocks passive MIND loss from "sanity" events, including variants,
 * and small background MIND ticks from parallel map/common events.
 * It intentionally does NOT freeze EXP or MP globally. Eating, spells,
 * enemy mind attacks, item effects and other scripted changes pass through.
 *
 * Based on the named F&H1 events documented in
 * Toby Yasha's TY_FnHWaitForInteraction.js.
 */
(function () {
    'use strict';

    var CONFIG = {
        stopPassiveHunger: true,
        stopPassiveMindDrain: true,
        logBlockedChanges: false
    };

    if (typeof Game_CommonEvent === 'undefined' ||
        typeof Game_Event === 'undefined' ||
        typeof Game_Actor === 'undefined' ||
        typeof Game_BattlerBase === 'undefined') {
        console.warn('[No Fear, No Hunger v1.0] RPG Maker MV classes not loaded.');
        return;
    }

    var hungerEventDepth = 0;
    var sanityEventDepth = 0;
    var parallelEventDepth = 0;
    var blockedUnlabeledMind = 0;
    var blockedHunger = 0;
    var blockedMind = 0;
    var seenHungerEvents = {};
    var seenSanityEvents = {};

    function isInBattle() {
        return typeof $gameParty !== 'undefined' && $gameParty &&
            typeof $gameParty.inBattle === 'function' && $gameParty.inBattle();
    }

    function nameOf(event) {
        try {
            var data = event && typeof event.event === 'function' ? event.event() : null;
            if (!data && event && typeof event._commonEventId === 'number' &&
                typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents) {
                data = $dataCommonEvents[event._commonEventId];
            }
            return data && typeof data.name === 'string' ? data.name.trim() : '';
        } catch (e) {
            return '';
        }
    }

    // Base-game common event IDs are retained by language-only translations.
    // Also require a parallel event containing an EXP decrease to avoid unrelated IDs.
    function isHungerEvent(event, name) {
        if (/^HUNGER_of_/i.test(name)) return true;
        var id = event && event._commonEventId;
        var data = typeof $dataCommonEvents !== 'undefined' && $dataCommonEvents && $dataCommonEvents[id];
        return id >= 124 && id <= 137 && data && data.trigger === 2 &&
            Array.isArray(data.list) && data.list.some(function (command) {
                return command.code === 315 && command.parameters && command.parameters[2] === 1;
            });
    }

    function isSanityName(name) {
        // Some maps use other labels than the exact "sanity" event name.
        // Never include "regain_sanity": that event restores Mind.
        return /^(?:sanity|mind)(?:[_ -]?(?:drain|loss|decrease|tick|passive|reduce|change|timer|[0-9]+))?$/i.test(name);
    }

    function trackedUpdate(original, self, args, kind, name) {
        var isHunger = kind === 'hunger';
        var isNamedSanity = kind === 'parallel' && isSanityName(name);
        if (isHunger) {
            hungerEventDepth++;
            seenHungerEvents[name] = (seenHungerEvents[name] || 0) + 1;
        } else {
            parallelEventDepth++;
            if (isNamedSanity) {
                sanityEventDepth++;
                seenSanityEvents[name] = (seenSanityEvents[name] || 0) + 1;
            }
        }
        try {
            return original.apply(self, args);
        } finally {
            if (isHunger) {
                hungerEventDepth--;
            } else {
                parallelEventDepth--;
                if (isNamedSanity) sanityEventDepth--;
            }
        }
    }

    function isPartyMember(battler) {
        return typeof $gameParty !== 'undefined' && $gameParty &&
            typeof $gameParty.members === 'function' &&
            $gameParty.members().indexOf(battler) !== -1;
    }

    // F&H1 runs one HUNGER_of_* parallel common event per relevant party member.
    // Mark the execution scope, *without skipping the event*. In particular this
    // keeps any existing hunger-stage checks / status updates running normally.
    var originalCommonUpdate = Game_CommonEvent.prototype.update;
    if (typeof originalCommonUpdate === 'function') {
        Game_CommonEvent.prototype.update = function () {
            if (isInBattle()) return originalCommonUpdate.apply(this, arguments);
            var eventName = nameOf(this);
            if (CONFIG.stopPassiveHunger && isHungerEvent(this, eventName)) {
                return trackedUpdate(originalCommonUpdate, this, arguments, 'hunger', eventName);
            }
            if (CONFIG.stopPassiveMindDrain) {
                // Parallel common events can handle ambient Mind on other maps.
                return trackedUpdate(originalCommonUpdate, this, arguments, 'parallel', eventName);
            }
            return originalCommonUpdate.apply(this, arguments);
        };
    }

    // Past Ma'habre and some other maps use parallel events whose names do
    // NOT match the exact word "sanity". Track all parallel event execution.
    // We only suppress tiny background losses for unnamed events below.
    var originalParallelUpdate = Game_Event.prototype.updateParallel;
    if (typeof originalParallelUpdate === 'function') {
        Game_Event.prototype.updateParallel = function () {
            if (CONFIG.stopPassiveMindDrain && !isInBattle()) {
                return trackedUpdate(originalParallelUpdate, this, arguments, 'parallel', nameOf(this));
            }
            return originalParallelUpdate.apply(this, arguments);
        };
    }

    // F&H1's hunger meter is INVERSELY related to EXP:
    // Hunger 1 corresponds to EXP 156; Hunger 100 corresponds to EXP 57.
    // Hunger ticks LOWER EXP, whereas eating RAISES it.
    // Suppress only EXP decreases made *inside* hunger parallel events;
    // food EXP gains and other gameplay events still work.
    var originalChangeExp = Game_Actor.prototype.changeExp;
    if (typeof originalChangeExp === 'function') {
        Game_Actor.prototype.changeExp = function (newExp, show) {
            if (CONFIG.stopPassiveHunger && hungerEventDepth > 0 &&
                !isInBattle() && typeof newExp === 'number' && isFinite(newExp) &&
                typeof this.currentExp === 'function' && newExp < this.currentExp()) {
                blockedHunger++;
                if (CONFIG.logBlockedChanges) {
                    console.log('[No Fear, No Hunger] Blocked hunger tick', newExp);
                }
                return;
            }
            return originalChangeExp.apply(this, arguments);
        };
    }

    // MP is Mind. Named sanity events are suppressed as before.
    // Other parallel events can cause automatic -1/-2 Mind ticks (including
    // in past Ma'habre). Only suppress these tiny losses for party members.
    // Item/skill use, scripted interactions and combat outside these scopes
    // continue to work normally. Do not globally freeze MP.
    var originalSetMp = Game_BattlerBase.prototype.setMp;
    if (typeof originalSetMp === 'function') {
        Game_BattlerBase.prototype.setMp = function (newMp) {
            var oldMp = this.mp;
            var loss = oldMp - newMp;
            var named = sanityEventDepth > 0;
            var smallParallelTick = parallelEventDepth > 0 && loss > 0 && loss <= 2;
            if (CONFIG.stopPassiveMindDrain && !isInBattle() &&
                typeof newMp === 'number' && isFinite(newMp) &&
                typeof oldMp === 'number' && isFinite(oldMp) && newMp < oldMp &&
                (named || smallParallelTick) && isPartyMember(this)) {
                blockedMind++;
                if (!named) blockedUnlabeledMind++;
                if (CONFIG.logBlockedChanges) {
                    console.log('[No Fear, No Hunger] Blocked ambient Mind drain',
                        oldMp, newMp, named ? 'named event' : 'parallel tick');
                }
                return;
            }
            return originalSetMp.apply(this, arguments);
        };
    }

    // Optional developer-console inspection. Does not modify saves.
    window.FNHCalmExploration = {
        version: '1.0',
        config: CONFIG,
        statistics: function () {
            return {
                blockedPassiveHunger: blockedHunger,
                blockedPassiveMind: blockedMind,
                blockedUnlabeledPassiveMind: blockedUnlabeledMind,
                hungerEventUpdates: seenHungerEvents,
                sanityEventUpdates: seenSanityEvents
            };
        }
    };
    console.log('[No Fear, No Hunger v1.0] Active. Named and parallel passive ticks filtered.');
}());
