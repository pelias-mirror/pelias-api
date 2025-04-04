const _ = require('lodash');
const nonEmptyString = (v) => _.isString(v) && !_.isEmpty(v);

/**
 * This sanitizer applies a layer filter in the case where only a single word was specified.
 *
 * It is based on the assumption that single-word inputs should not, and need not match
 * results from the 'address' layer.
 *
 * The rationale is that in order to specify enough information to retrieve an address the
 * user must, at minimum enter both a housenumber and a street name.
 *
 * Note: we cannot exclude other layers such as 'venue' (eg. Starbucks) or 'street'
 * (eg. Gleimstraße) because they may have valid single-word names.
 *
 * The address layer contains the most records by a large margin, so excluding
 * address results where they are not nessesary will provide significant
 * performance benefits.
 *
 * Update: added warning message to inform user when this functionality is enabled
 * Update: added additional check that enforces that the input must also contain at least one numeral
 */

 // note: this runs before libpostal (which is a service)

const ADDRESS_FILTER_WARNING = 'performance optimization: excluding \'address\' layer';

function can_remove_addresses(clean) {
  // default to using the full 'clean.text'
  // note: this should already have superfluous characters removed
  let input = clean.text;

  // if a parser has removed tokens, use the parsed text instead, this
  // is the text which will be queried against the 'name.default' field.
  // @todo: this logic is duplicated from 'query/text_parser.js' and may
  // be subject to change.
  if (_.isObject(clean.parsed_text) && !_.isEmpty(clean.parsed_text)) {

    var isStreetAddress = clean.parsed_text.hasOwnProperty('housenumber') && clean.parsed_text.hasOwnProperty('street');

    // use $subject where available (pelias parser)
    if (_.has(clean, 'parsed_text.subject')) {
      input = clean.parsed_text.subject;
    }

    // if 'pelias_parser' or 'libpostal' identified input as a street address
    else if (isStreetAddress) {
      input = clean.parsed_text.housenumber + ' ' + clean.parsed_text.street;
    }

    // else if the 'naive parser' was used, input is equal to 'name'
    else if (nonEmptyString(clean.parsed_text.admin_parts) && nonEmptyString(clean.parsed_text.name)) {
      input = clean.parsed_text.name;
    }
  }

  // count the number of words specified
  let totalWords = input.split(/\s+/).filter(nonEmptyString).length;

  // check that at least one numeral was specified
  let hasNumeral = /\d/.test(input);

  // do not consider numeric street names, such as '26 st' in numeric check.
  if( _.has(clean, 'parsed_text.street') ){
    hasNumeral = /\d/.test(input.replace(clean.parsed_text.street, ''));
  }

  // if less than two words were specified /or no numeral is present
  // then it is safe to apply the layer filter
  return totalWords < 2 || !hasNumeral;
}

function _setup(tm) {

  return {
    sanitize: function _sanitize(__, clean) {

      // error & warning messages
      let messages = { errors: [], warnings: [] };

      // do nothing if user has explicitly specified positive layers in the request
      if ( _.isArray(clean.positive_layers) && !_.isEmpty(clean.positive_layers) ) {
        return messages;
      }

      // do nothing if no input text specified in the request
      if (!nonEmptyString(clean.text)) {
        return messages;
      }

      if (can_remove_addresses(clean)) {
        // handle the common case where neither sources nor (positive) layers were specified
        if (!_.isArray(clean.sources) || _.isEmpty(clean.sources)) {
          // if there are no layers already set, start with the list of all of them
          if (_.isEmpty(clean.layers)) {
            clean.layers = tm.layers;
          }

          // filter the existing list of layers so it excludes 'address'
          clean.layers = clean.layers.filter(item => item !== 'address');
          messages.warnings.push(ADDRESS_FILTER_WARNING);
        }

        // handle the case where 'sources' were explicitly specified
        else if (_.isArray(clean.sources)) {
          // we need to create a list of layers for the specified sources
          let sourceLayers = clean.sources.reduce((l, key) => l.concat(tm.layers_by_source[key] || []), []);
          sourceLayers = _.uniq(sourceLayers); // dedupe

          // if the sources specified do not have any addresses or if removing the
          // address layer would result in an empty list, then this is a no-op
          if (sourceLayers.length < 2 || !sourceLayers.includes('address')) {
            return messages;
          }

          // create a list of all "possible layers": layers from the specified sources, minus address layer
          const possibleLayers = sourceLayers.filter(item => item !== 'address');

          // intersect the possible layers with any already specified layer preferences
          if (_.isArray(clean.layers) && clean.layers.length > 1) {
            // layers already exist, intersect
            clean.layers = _.intersection(clean.layers, possibleLayers);
          } else {
            // no layers already, use all possible layers
            clean.layers = possibleLayers;
          }

          messages.warnings.push(ADDRESS_FILTER_WARNING);
        }
      }

      return messages;
    }
  };
}

module.exports = _setup;
