// firebase.ts
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, get, child } from "firebase/database";

// Firebase configuration
// firebase.ts
const firebaseConfig = {
  apiKey: "AIzaSyARxhRbn4XgchH4QaGNQkWcV4VKtH2z1dM",
  authDomain: "gamail-discord-integration.firebaseapp.com",
  databaseURL: "https://gamail-discord-integration-default-rtdb.firebaseio.com", // Add the correct database URL
  projectId: "gamail-discord-integration",
  storageBucket: "gamail-discord-integration.appspot.com",
  messagingSenderId: "189736297347",
  appId: "1:189736297347:web:48a85236090a90e4538cb6",
  measurementId: "G-H13NXNEH3G",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

export { database, ref, set, get, child };
