import { waitUntil } from 'async-test-util';

import config from './config';
import * as schemas from '../helper/schemas';
import * as schemaObjects from '../helper/schema-objects';
import {
    createRxDatabase,
    randomCouchString,
    RxCollection
} from '../../';

import {
    getRxStorageMemory,
    RxStorageInstanceMemory
} from '../../plugins/memory'

import { HumanDocumentType } from '../helper/schemas';

config.parallel('conflict-handling.test.js', () => {
    describe('RxStorageInterface', () => {
        it('should resolve the emitted conflict of conflictResolutionTasks()', async () => {
            const db = await createRxDatabase({
                name: randomCouchString(10),
                storage: getRxStorageMemory(),
            });
            const cols = await db.addCollections({
                humans: {
                    schema: schemas.human
                }
            });
            const collection: RxCollection<HumanDocumentType> = cols.humans;
            const doc = await collection.insert(schemaObjects.human());
            const docData = doc.toJSON(true);
            const storageInstance: RxStorageInstanceMemory<HumanDocumentType> = collection.storageInstance as any;
            const oldResolveConflictResolutionTask = storageInstance.resolveConflictResolutionTask.bind(storageInstance);
            const resolvedTasks = new Set<string>();
            storageInstance.resolveConflictResolutionTask = function (taskSolution) {
                resolvedTasks.add(taskSolution.id);
                return oldResolveConflictResolutionTask(taskSolution);
            }

            const taskId = randomCouchString();
            storageInstance.internals.conflictResolutionTasks$.next({
                id: taskId,
                context: '',
                input: {
                    newDocumentState: docData,
                    realMasterState: docData,
                    assumedMasterState: docData
                }
            });
            await waitUntil(() => resolvedTasks.has(taskId));

            db.destroy();
        });
    });
});
