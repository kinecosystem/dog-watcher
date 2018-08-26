'use strict';
/**
 * The backup coordinator.  This module strings together all of the necessary actions to do a full
 * backup.
 */
const async = require('async'),
	fs = require('fs-extra'),
	temp = require('temp'),
	os = require('os'),
	log4js = require('log4js'),

	config = require('../config.json'),
	dataDog = require('./dataDog.js'),
	git = require('./git.js'),
	logger = log4js.getLogger('dog-watcher');

let workDir;

/**
 * Get all boards and monitors from DataDog and check them into Git if necessary.
 */
const performBackup = function (callback) {
	async.waterfall(
		[
			async.apply(temp.mkdir, 'dog-watcher-work'),
			function (dir, next) {
				workDir = dir;
				git.runCommand(['clone', config.gitRepoForBackups, workDir], workDir, next);
			},
			async.apply(dataDog.getBoards, 'dash'),
			async.apply(dataDog.getBoards, 'screen'),
			async.apply(dataDog.getMonitors),

			async.apply(git.runCommand, ['add', '.']),
			async.apply(git.runCommand, ['commit', '-m', replaceTemplateVars(config.commitMessage)]),
			async.apply(git.runCommand, ['push', 'origin', 'master'])
		],
		function (error) {
			let success,
				eventErrorMessage;
			if (error && error.message === git.GIT_NOOP_MESSAGE) {
				logger.info('There was nothing new to commit.');
				if (config.sendEventOnNoop !== 'true') {
					logger.info('No DataDog event was sent.');
					return callback();
				}
				eventErrorMessage = error.message;
				// not a real error.  Get rid of it.
				error = undefined;

			} else if (error) {
				logger.error('There was an error during the backup attempt.', error);
				success = false;
				eventErrorMessage = error.message;

			} else {
				success = true;
			}
			dataDog.sendDataDogEvent(success, eventErrorMessage, function () {
				logger.debug('Event sent to Datadog');
				callback(error);
			})
		});
};

/**
 * Perform the backup and clean up the work dir on completion.  At the end if there was a
 * successful backup or a failure an event will be sent to DataDog.
 */
const run = function (callback) {
	performBackup(function (error) {
		fs.remove(workDir, function (removeError) {
			if (removeError) {
				console.error('There was an error removing the work dir.', removeError);
			}
			callback(error);
		});
	});
};

const getMachineIp = function* () {
	/*
	 * Generator that returns all public IP address.
	 * (Although we use this only for the first address
	 * it makes sense that a function like this will return all IPs
	 * if exist)
	 */
	const interfaces = os.networkInterfaces();
	for (let nameDataPair of Object.entries(interfaces)) {
		for (let alias of nameDataPair[1]) {
			if ('IPv4' !== alias.family || alias["internal"] !== false) {
				continue;
			}
			yield alias.address;
		}
	}
};


const replaceTemplateVars = function(template){
	return template.replace('{IP}', getMachineIp.next().value);
};

logger.setLevel(process.env.LOG_LEVEL || 'INFO');

module.exports = run;
