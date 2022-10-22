import type {
    WithDeleted
} from '../../types';
import { flatClone } from '../../util';

// does nothing
export const DEFAULT_MODIFIER = (d: any) => Promise.resolve(d);


export function swapDefaultDeletedToDeletedField<RxDocType>(
    deletedField: string,
    doc: WithDeleted<RxDocType>
): RxDocType {
    if (deletedField === '_deleted') {
        return doc;
    } else {
        doc = flatClone(doc);
        const isDeleted = !!doc._deleted;
        (doc as any)[deletedField] = isDeleted;
        delete (doc as any)._deleted;
        return doc;
    }
}


export function swapDeletedFieldToDefaultDeleted<RxDocType>(
    deletedField: string,
    doc: RxDocType
): WithDeleted<RxDocType> {
    if (deletedField === '_deleted') {
        return doc as any;
    } else {
        doc = flatClone(doc);
        const isDeleted = !!(doc as any)[deletedField];
        (doc as any)._deleted = isDeleted;
        delete (doc as any)[deletedField];
        return doc as any;
    }
}
