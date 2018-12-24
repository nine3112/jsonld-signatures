/*!
 * Copyright (c) 2018 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const constants = require('./constants');
const jsonld = require('jsonld');
const {extendContextLoader, strictDocumentLoader} = require('./documentLoader');
const strictExpansionMap = require('./expansionMap');

module.exports = class ProofSet {
  /**
   * Adds a Linked Data proof to a document. If the document contains other
   * proofs, the new proof will be appended to the existing set of proofs.
   *
   * Important note: This method assumes that the term `proof` in the given
   * document has the same definition as the `https://w3id.org/security/v2`
   * JSON-LD @context.
   *
   * @param document {object|string} Object to be signed, either a string URL
   *   (resolved via the given `documentLoader`) or a plain object (JSON-LD
   *   document).
   * @param options {object} Options hashmap.
   *
   * A `suite` option is required:
   *
   * @param options.suite {LinkedDataSignature} a signature suite instance
   *   that will create the proof.
   *
   * A `purpose` option is required:
   *
   * @param options.purpose {ProofPurpose} a proof purpose instance that will
   *   augment the proof with information describing its intended purpose.
   *
   * Advanced optional parameters and overrides:
   *
   * @param [documentLoader] {function} a custom document loader,
   *   `Promise<RemoteDocument> documentLoader(url)`.
   * @param [expansionMap] {function} A custom expansion map that is
   *   passed to the JSON-LD processor; by default a function that will throw
   *   an error when unmapped properties are detected in the input, use `false`
   *   to turn this off and allow unmapped properties to be dropped or use a
   *   custom function.
   *
   * @return {Promise<object>} resolves with the signed document, with
   *   the signature in the top-level `proof` property.
   */
  async add(document, {
    suite, purpose, documentLoader, expansionMap} = {}) {
    if(!(suite && purpose)) {
      throw new TypeError(
        '"options.suite" and "options.purpose" must be given.');
    }

    if(documentLoader) {
      documentLoader = extendContextLoader(documentLoader);
    } else {
      documentLoader = strictDocumentLoader;
    }
    if(expansionMap !== false) {
      expansionMap = strictExpansionMap;
    }

    if(typeof document === 'string') {
      // fetch document
      document = await documentLoader(document);
    }

    // TODO: add flag for accepting foreign input context

    // shallow clone the document, excluding any existing proof(s)
    const input = {...document};
    delete input.proof;

    // create the new proof (suites MUST output a proof using the security-v2
    // `@context`)
    const proof = await suite.createProof(
      input, {purpose, documentLoader, expansionMap});

    // TODO: add flag for compacting to foreign input context

    // compact proof to match document's context
    const expandedProof = {
      'https://w3id.org/security#proof': {
        '@graph': proof
      }
    };
    const ctx = jsonld.getValues(document, '@context');
    const options = {documentLoader, expansionMap};
    const compactProof = await jsonld.compact(expandedProof, ctx, options);
    delete compactProof['@context'];

    // add proof to document
    jsonld.addValue(document, 'proof', compactProof.proof);
    return document;
  }

  /**
   * Verify Linked Data proof(s) on a document. The proofs to be verified
   * must match the given proof purpose.
   *
   * Important note: This method assumes that the term `proof` in the given
   * document has the same definition as the `https://w3id.org/security/v2`
   * JSON-LD @context.
   *
   * @param document {object|string} Object with one or more proofs to be
   *   verified, either a string URL (resolved to an object via the given
   *   `documentLoader`) or a plain object (JSON-LD document).
   * @param options {object} Options hashmap.
   *
   * A `suite` option is required:
   *
   * @param options.suite {LinkedDataSignature or Array of LinkedDataSignature}
   *   acceptable signature suite instances for verifying the proof(s).
   *
   * A `purpose` option is required:
   *
   * @param options.purpose {ProofPurpose} a proof purpose instance that will
   *   match proofs to be verified and ensure they were created according to
   *   the appropriate purpose.
   *
   * Advanced optional parameters and overrides:
   *
   * @param [documentLoader] {function} a custom document loader,
   *   `Promise<RemoteDocument> documentLoader(url)`.
   * @param [expansionMap] {function} A custom expansion map that is
   *   passed to the JSON-LD processor; by default a function that will throw
   *   an error when unmapped properties are detected in the input, use `false`
   *   to turn this off and allow unmapped properties to be dropped or use a
   *   custom function.
   *
   * @return {Promise<object>} resolves with an object with a `verified`
   *   boolean property that is `true` if at least one proof matching the
   *   given purpose and suite verifies and `false` otherwise; a `results`
   *   property with an array of detailed results; if `false` an `error`
   *   property will be present.
   */
  async verify(document, {
    suite, purpose, documentLoader, expansionMap} = {}) {
    if(!(suite && purpose)) {
      throw new TypeError(
        '"options.suite" and "options.purpose" must be given.');
    }
    if(!Array.isArray(suite)) {
      suite = [suite];
    }

    if(documentLoader) {
      documentLoader = extendContextLoader(documentLoader);
    } else {
      documentLoader = strictDocumentLoader;
    }
    if(expansionMap !== false) {
      expansionMap = strictExpansionMap;
    }

    try {
      if(typeof document === 'string') {
        // fetch document
        document = await documentLoader(document);
      } else {
        // clone document to allow for removal of `proof` set
        document = {...document};
      }

      // TODO: add flag for accepting foreign input context

      const {proof: proofSet} = document;
      if(!proofSet) {
        throw new Error(
          'Could not verify any proofs; the document has no "proof" property.');
      }
      delete document.proof;

      // compact proofs to security-v2 context
      const expanded = {
        proof: proofSet
      };
      const ctx = jsonld.getValues(document, '@context');
      expanded['@context'] = ctx;
      const options = {documentLoader, expansionMap};
      const compact = await jsonld.compact(
        expanded, constants.SECURITY_CONTEXT_URL, options);

      // filter out matching proofs
      const proofs = jsonld.getValues(compact, 'proof').map(proof => {
        proof['@context'] = constants.SECURITY_CONTEXT_URL;
        return proof;
      });
      const matches = proofs.filter(proof => purpose.match(
        {proof, document, documentLoader, expansionMap}));
      if(matches.length === 0) {
        throw new Error(
          'Could not verify any proofs; no proofs matched the required ' +
          'purpose.');
      }

      // verify each matching proof
      const results = (await Promise.all(matches.map(proof => {
        for(const s of suite) {
          if(s.match({proof, document, documentLoader, expansionMap})) {
            return s.verifyProof(
              {proof, document, purpose, documentLoader, expansionMap})
              .catch(error => {
                return {verified: false, error};
              });
          }
        }
        return {
          verified: false,
          error: new Error('No matching suite found.')
        };
      }))).map((r, i) => ({proof: matches[i], ...r}));
      const verified = results.some(r => r.verified);
      if(!verified) {
        const errors = [].concat(
          ...results.filter(r => r.error).map(r => r.error));
        const result = {verified, results};
        if(errors.length > 0) {
          result.error = errors;
        }
        return result;
      }
      return {verified, results};
    } catch(error) {
      return {verified: false, error};
    }
  }
};