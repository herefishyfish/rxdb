import type {
    RxPluginPreCreateRxQueryArgs,
    MangoQuery,
    RxPluginPrePrepareQueryArgs
} from '../../types';
import deepEqual from 'fast-deep-equal';
import { newRxError, newRxTypeError } from '../../rx-error';
import {
    massageSelector
} from 'pouchdb-selector-core';

/**
 * accidentally passing a non-valid object into the query params
 * is very hard to debug especially when queries are observed
 * This is why we do some checks here in dev-mode
 */
export function checkQuery(args: RxPluginPreCreateRxQueryArgs) {
    const isPlainObject = Object.prototype.toString.call(args.queryObj) === '[object Object]';
    if (!isPlainObject) {
        throw newRxTypeError('QU11', {
            op: args.op,
            collection: args.collection.name,
            queryObj: args.queryObj
        });
    }

    const validKeys: (keyof MangoQuery)[] = [
        'selector',
        'limit',
        'skip',
        'sort',
        'index'
    ];
    Object.keys(args.queryObj).forEach(key => {
        if (!(validKeys as string[]).includes(key)) {
            throw newRxTypeError('QU11', {
                op: args.op,
                collection: args.collection.name,
                queryObj: args.queryObj,
                key,
                args: {
                    validKeys
                }
            });
        }
    });
}


export function checkMangoQuery(args: RxPluginPrePrepareQueryArgs) {
    const schema = args.rxQuery.collection.schema.jsonSchema;

    /**
     * Ensure that all top level fields are included in the schema.
     * TODO this check can be augmented to also check sub-fields.
     */
    const massagedSelector = massageSelector(args.mangoQuery.selector);
    const schemaTopLevelFields = Object.keys(schema.properties);
    Object.keys(massagedSelector)
        // do not check operators
        .filter(fieldOrOperator => !fieldOrOperator.startsWith('$'))
        // skip this check on non-top-level fields
        .filter(field => !field.includes('.'))
        .forEach(field => {
            if (!schemaTopLevelFields.includes(field)) {
                throw newRxError('QU13', {
                    schema,
                    field,
                    query: args.mangoQuery,
                });
            }
        });


    /**
     * ensure if custom index is set,
     * it is also defined in the schema
     */
    const schemaIndexes = schema.indexes ? schema.indexes : [];
    const index = args.mangoQuery.index;
    if (index) {
        const isInSchema = schemaIndexes.find(schemaIndex => deepEqual(schemaIndex, index));
        if (!isInSchema) {
            throw newRxError(
                'QU12',
                {
                    collection: args.rxQuery.collection.name,
                    query: args.mangoQuery,
                    schema
                }
            );
        }
    }
}
