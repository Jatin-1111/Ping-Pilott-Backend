import { validationResult } from 'express-validator';
import { validationBody } from '../utils/apiError.js';

/**
 * Validation middleware
 * @desc Validates request data using express-validator
 */
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // Extract validation errors
        const errorMessages = errors.array().map(error => ({
            field: error.path,
            message: error.msg
        }));

        // message is the first problem in words a person can act on (clients show it); errors lists them all
        return res.status(400).json(validationBody(errorMessages));
    }

    next();
};

export default validate;