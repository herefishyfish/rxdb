import assert from 'assert';

import {
    randomCouchString,
    RxCollection,
    ensureNotFalsy,
    WithDeleted
} from '../';

import * as humansCollection from './helper/humans-collection';
import * as schemaObjects from './helper/schema-objects';

import {
    replicateNats,
    NatsSyncOptions,
    RxNatsReplicationState
} from '../plugins/replication-nats';
import {
    ensureCollectionsHaveEqualState,
    ensureReplicationHasNoErrors
} from './helper/test-util';
import {
    DeliverPolicy,
    JSONCodec,
    connect
} from 'nats';


const connectionSettings = { servers: 'localhost:4222' };
const connectionStatePromise = (async () => {
    const jc = JSONCodec();
    const nc = await connect(connectionSettings);
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    return {
        jc,
        nc,
        jsm,
        js
    };
})();

/**
 * The tests for the NATS replication plugin
 * do not run in the normal test suite
 * because it is too slow to setup the NATS backend.
 */
describe('replication-nats.test.js', () => {
    /**
     * Use a low batchSize in all tests
     * to make it easier to test boundaries.
     */
    const batchSize = 5;
    type TestDocType = schemaObjects.HumanWithTimestampDocumentType;
    async function getAllDocsOfServer(
        name: string
    ): Promise<TestDocType[]> {
        const connectionState = await connectionStatePromise;
        await connectionState.jsm.streams.add({
            name,
            subjects: [
                name + '.*'
            ]
        });
        const consumer = await connectionState.js.consumers.get(name, {
            deliver_policy: DeliverPolicy.LastPerSubject
        });
        const messageResponse = await consumer.fetch();
        await (messageResponse as any).signal;
        await messageResponse.close();
        const useMessages: WithDeleted<TestDocType>[] = [];
        for await (const m of messageResponse) {
            useMessages.push(m.json());
            m.ack();
        }
        return useMessages;
    }

    async function syncOnce(
        collection: RxCollection,
        natsName: string,
        options?: Pick<NatsSyncOptions<any>, 'pull' | 'push'>
    ) {
        const replicationState = replicateNats({
            collection,
            replicationIdentifier: 'nats-once-' + natsName,
            streamName: natsName,
            subjectPrefix: natsName,
            connection: connectionSettings,
            live: false,
            pull: options?.pull ?? {},
            push: options?.push ?? {},
        });
        ensureReplicationHasNoErrors(replicationState);
        await replicationState.awaitInitialReplication();
    }
    function syncNats<RxDocType = TestDocType>(
        collection: RxCollection<RxDocType>,
        natsName: string
    ): RxNatsReplicationState<RxDocType> {
        const replicationState = replicateNats<RxDocType>({
            collection,
            replicationIdentifier: 'nats-' + natsName,
            streamName: natsName,
            subjectPrefix: natsName,
            connection: connectionSettings,
            pull: {
                batchSize
            },
            push: {
                batchSize
            }
        });
        ensureReplicationHasNoErrors(replicationState);
        return replicationState;
    }


    describe('live replication', () => {
        it('push replication to client-server', async () => {
            const collection = await humansCollection.createHumanWithTimestamp(2, undefined, false);

            const natsName = randomCouchString(10);

            console.log('################ 0.1');

            const replicationState = syncNats(collection, natsName);
            ensureReplicationHasNoErrors(replicationState);
            console.log('################ 0.2');
            await replicationState.awaitInitialReplication();
            console.log('################ 0.3');

            let docsOnServer = await getAllDocsOfServer(natsName);
            assert.strictEqual(docsOnServer.length, 2);
            console.log('################ 0.4');

            // insert another one
            await collection.insert(schemaObjects.humanWithTimestamp());
            await replicationState.awaitInSync();


            console.log('################ 1');

            docsOnServer = await getAllDocsOfServer(natsName);
            assert.strictEqual(docsOnServer.length, 3);

            // update one
            const doc = await collection.findOne().exec(true);
            await doc.incrementalPatch({ age: 100 });
            await replicationState.awaitInSync();
            docsOnServer = await getAllDocsOfServer(natsName);
            assert.strictEqual(docsOnServer.length, 3);
            const serverDoc = ensureNotFalsy(docsOnServer.find(d => d.id === doc.primary));
            assert.strictEqual(serverDoc.age, 100);

            console.log('################ 2');

            // delete one
            await doc.getLatest().remove();
            await replicationState.awaitInSync();
            docsOnServer = await getAllDocsOfServer(natsName);
            // must still have 3 because there are no hard deletes
            assert.strictEqual(docsOnServer.length, 3);
            assert.ok(docsOnServer.find(d => (d as any)._deleted));

            console.log('################ 3');


            collection.database.destroy();
        });
        it('two collections', async () => {
            const collectionA = await humansCollection.createHumanWithTimestamp(1, undefined, false);
            const collectionB = await humansCollection.createHumanWithTimestamp(1, undefined, false);

            const natsName = randomCouchString(10);
            const replicationStateA = syncNats(collectionA, natsName);

            ensureReplicationHasNoErrors(replicationStateA);
            await replicationStateA.awaitInitialReplication();


            const replicationStateB = syncNats(collectionB, natsName);
            ensureReplicationHasNoErrors(replicationStateB);
            await replicationStateB.awaitInitialReplication();

            await replicationStateA.awaitInSync();

            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            // insert one
            await collectionA.insert(schemaObjects.humanWithTimestamp({ id: 'insert', name: 'InsertName' }));
            await replicationStateA.awaitInSync();

            await replicationStateB.awaitInSync();
            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            // delete one
            await collectionB.findOne().remove();
            await replicationStateB.awaitInSync();
            await replicationStateA.awaitInSync();
            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            // insert many
            await collectionA.bulkInsert(
                new Array(10)
                    .fill(0)
                    .map(() => schemaObjects.humanWithTimestamp({ name: 'insert-many' }))
            );
            await replicationStateA.awaitInSync();

            await replicationStateB.awaitInSync();
            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            // insert at both collections at the same time
            await Promise.all([
                collectionA.insert(schemaObjects.humanWithTimestamp({ name: 'insert-parallel-A' })),
                collectionB.insert(schemaObjects.humanWithTimestamp({ name: 'insert-parallel-B' }))
            ]);
            await replicationStateA.awaitInSync();
            await replicationStateB.awaitInSync();
            await replicationStateA.awaitInSync();
            await replicationStateB.awaitInSync();
            await ensureCollectionsHaveEqualState(collectionA, collectionB);

            collectionA.database.destroy();
            collectionB.database.destroy();
        });
    });
    describe('conflict handling', () => {
        it('should keep the master state as default conflict handler', async () => {
            const natsName = randomCouchString(10);
            const c1 = await humansCollection.create(1);
            const c2 = await humansCollection.create(0);

            await syncOnce(c1, natsName);
            await syncOnce(c2, natsName);

            const doc1 = await c1.findOne().exec(true);
            const doc2 = await c2.findOne().exec(true);

            // make update on both sides
            await doc1.incrementalPatch({ firstName: 'c1' });
            await doc2.incrementalPatch({ firstName: 'c2' });

            await syncOnce(c2, natsName);

            // cause conflict
            await syncOnce(c1, natsName);

            /**
             * Must have kept the master state c2
             */
            assert.strictEqual(doc1.getLatest().firstName, 'c2');

            c1.database.destroy();
            c2.database.destroy();
        });
    });
});
