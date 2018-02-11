/**
 * @flow
 * Firestore Transaction representation wrapper
 */
import { getAppEventName, SharedEventEmitter } from '../../utils/events';
import { getLogger } from '../../utils/log';
import { getNativeModule } from '../../utils/native';
import Transaction from './Transaction';
import type Firestore from './';

let transactionId = 0;

/**
 * Uses the push id generator to create a transaction id
 * @returns {number}
 * @private
 */
const generateTransactionId = (): number => transactionId++;

export type TransactionMeta = {
  id: number,
  stack: Array<string>,
  reject: null | Function,
  resolve: null | Function,
  transaction: Transaction,
  updateFunction: (transaction: Transaction) => Promise<any>,
};

type TransactionEvent = {
  id: number,
  type: 'update' | 'error' | 'complete',
  error: ?{ code: string, message: string },
};

/**
 * @class TransactionHandler
 */
export default class TransactionHandler {
  _firestore: Firestore;
  _transactionListener: Function;
  _pending: { [number]: TransactionMeta };

  constructor(firestore: Firestore) {
    this._pending = {};
    this._firestore = firestore;
    this._transactionListener = SharedEventEmitter.addListener(
      getAppEventName(this._firestore, 'firestore_transaction_event'),
      this._handleTransactionEvent.bind(this)
    );
  }

  /**
   * -------------
   * INTERNAL API
   * -------------
   */

  /**
   * Add a new transaction and start it natively.
   * @param updateFunction
   */
  _add(
    updateFunction: (transaction: Transaction) => Promise<any>
  ): Promise<any> {
    const id = generateTransactionId();
    const meta = {
      id,
      reject: null,
      resolve: null,
      updateFunction,
      stack: new Error().stack.slice(1),
    };

    meta.transaction = new Transaction(this._firestore, meta);
    this._pending[id] = meta;

    // deferred promise
    return new Promise((resolve, reject) => {
      getNativeModule(this._firestore).transactionBegin(id);
      meta.resolve = r => {
        resolve(r);
        this._remove(id);
      };
      meta.reject = e => {
        reject(e);
        this._remove(id);
      };
    });
  }

  /**
   * Destroys a local instance of a transaction meta
   *
   * @param id
   * @param pendingAbort Notify native that there's still an transaction in
   *        progress that needs aborting - this is to handle a JS side
   *        exception
   * @private
   */
  _remove(id, pendingAbort = false) {
    // todo confirm pending arg no longer needed
    getNativeModule(this._firestore).transactionDispose(id, pendingAbort);
    // TODO may need delaying to next event loop
    delete this._pending[id];
  }

  /**
   * -------------
   *    EVENTS
   * -------------
   */

  /**
   * Handles incoming native transaction events and distributes to correct
   * internal handler by event.type
   *
   * @param event
   * @returns {*}
   * @private
   */
  _handleTransactionEvent(event: TransactionEvent) {
    switch (event.type) {
      case 'update':
        return this._handleUpdate(event);
      case 'error':
        return this._handleError(event);
      case 'complete':
        return this._handleComplete(event);
      default:
        getLogger(this._firestore).warn(
          `Unknown transaction event type: '${event.type}'`,
          event
        );
        return undefined;
    }
  }

  /**
   * Handles incoming native transaction update events
   *
   * @param event
   * @private
   */
  async _handleUpdate(event: TransactionEvent) {
    const { id } = event;
    // abort if no longer exists js side
    if (!this._pending[id]) return this._remove(id);

    const { updateFunction, transaction, reject } = this._pending[id];

    // clear any saved state from previous transaction runs
    transaction._prepare();

    let finalError;
    let updateFailed;
    let pendingResult;

    // run the users custom update functionality
    try {
      const possiblePromise = updateFunction(transaction);

      // validate user has returned a promise in their update function
      // TODO must it actually return a promise? Can't find any usages of it without one...
      if (!possiblePromise || !possiblePromise.then) {
        finalError = new Error(
          'Update function for `firestore.runTransaction(updateFunction)` must return a Promise.'
        );
      } else {
        pendingResult = await possiblePromise;
      }
    } catch (exception) {
      updateFailed = true; // in case the user rejects with nothing
      finalError = exception;
    }

    // reject the final promise and remove from native
    if (updateFailed) {
      return reject(finalError);
    }

    // capture the resolved result as we'll need this
    // to resolve the runTransaction() promise when
    // native emits that the transaction is final
    transaction._pendingResult = pendingResult;

    // send the buffered update/set/delete commands for native to process
    return getNativeModule(this._firestore).transactionProcessUpdateResponse(
      id,
      transaction._commandBuffer
    );
  }

  /**
   * Handles incoming native transaction error events
   *
   * @param event
   * @private
   */
  _handleError(event: TransactionEvent) {
    const { id, error } = event;
    const meta = this._pending[id];

    if (meta) {
      const { code, message } = error;
      // build a JS error and replace its stack
      // with the captured one at start of transaction
      // so it's actually relevant to the user
      const errorWithStack = new Error(message);
      errorWithStack.code = code;
      errorWithStack.stack = meta.stack;

      meta.reject(errorWithStack);
    }
  }

  /**
   * Handles incoming native transaction complete events
   *
   * @param event
   * @private
   */
  _handleComplete(event: TransactionEvent) {
    const { id } = event;
    const meta = this._pending[id];

    if (meta) {
      const pendingResult = meta.transaction._pendingResult;
      meta.resolve(pendingResult);
    }
  }
}