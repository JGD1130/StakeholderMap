import { collectionGroup, getDocs, doc, setDoc } from 'firebase/firestore';
import { db } from '../src/firebaseConfig.js';
import { bId, fId, rId } from '../src/utils/idUtils.js';

function parseArgs(argv) {
  const args = {};
  argv.forEach((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key) args[key] = value ?? true;
  });
  return args;
}

async function backfillRooms(universityId) {
  if (!universityId) throw new Error('Missing required --university argument');

  const cg = collectionGroup(db, 'rooms');
  const snap = await getDocs(cg);
  const writes = [];

  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const original = data.original || {};
    const buildingName = original.buildingName || data.buildingName;
    const floorLabel = original.floorLabel || data.floorLabel;
    const featureId = original.featureId || data.revitId || docSnap.id.split('__').pop();

    if (!buildingName || !floorLabel || !featureId) return;
    if (!docSnap.ref.path.includes(`/universities/${universityId}/`)) return;

    const destRef = doc(
      db,
      'universities', universityId,
      'buildings', bId(buildingName),
      'floors', fId(floorLabel),
      'rooms', rId(buildingName, floorLabel, featureId)
    );

    writes.push(
      setDoc(
        destRef,
        {
          ...data,
          original: {
            buildingName,
            floorLabel,
            featureId: String(featureId)
          },
          migratedAt: new Date()
        },
        { merge: true }
      )
    );
  });

  await Promise.all(writes);
  console.log(`Backfilled ${writes.length} rooms for ${universityId}`);
}

const args = parseArgs(process.argv.slice(2));

if (import.meta.url === `file://${process.argv[1]}`) {
  backfillRooms(args.university || args.u)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { backfillRooms };
