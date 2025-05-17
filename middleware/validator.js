import { validationResult } from 'express-validator';

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

        return res.status(400).json({
            status: 'error',
            message: 'Validation error',
            errors: errorMessages
        });
    }

    next();
};

export default validate;