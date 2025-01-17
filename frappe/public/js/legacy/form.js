// Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
// MIT License. See license.txt

/* Form page structure

	+ this.parent (either FormContainer or Dialog)
		+ this.wrapper
			+ this.toolbar
			+ this.form_wrapper
					+ this.head
					+ this.body
						+ this.layout
				+ this.sidebar
			+ this.footer
*/

/* eslint-disable no-console */

frappe.provide('_f');
frappe.provide('frappe.ui.form');

frappe.ui.form.Controller = Class.extend({
	init: function(opts) {
		$.extend(this, opts);
	}
});

_f.frms = {};

_f.Frm = function(doctype, parent, in_form) {
	this.docname = '';
	this.doctype = doctype;
	this.hidden = false;
	this.refresh_if_stale_for = 120;

	var me = this;
	this.opendocs = {};
	this.custom_buttons = {};
	this.sections = [];
	this.grids = [];
	this.cscript = new frappe.ui.form.Controller({frm:this});
	this.events = {};
	this.pformat = {};
	this.fetch_dict = {};
	this.parent = parent;
	this.tinymce_id_list = [];

	this.setup_meta(doctype);

	// show in form instead of in dialog, when called using url (router.js)
	this.in_form = in_form ? true : false;

	// notify on rename
	$(document).on('rename', function(event, dt, old_name, new_name) {
		if(dt==me.doctype)
			me.rename_notify(dt, old_name, new_name);
	});
};

_f.Frm.prototype.check_doctype_conflict = function(docname) {
	if(this.doctype=='DocType' && docname=='DocType') {
		frappe.msgprint(__('Allowing DocType, DocType. Be careful!'));
	} else if(this.doctype=='DocType') {
		if (frappe.views.formview[docname] || frappe.pages['List/'+docname]) {
			window.location.reload();
			//	frappe.msgprint(__("Cannot open {0} when its instance is open", ['DocType']))
			// throw 'doctype open conflict'
		}
	} else {
		if (frappe.views.formview.DocType && frappe.views.formview.DocType.frm.opendocs[this.doctype]) {
			window.location.reload();
			//	frappe.msgprint(__("Cannot open instance when its {0} is open", ['DocType']))
			// throw 'doctype open conflict'
		}
	}
};

_f.Frm.prototype.setup = function() {
	this.fields = [];
	this.fields_dict = {};
	this.state_fieldname = frappe.workflow.get_state_fieldname(this.doctype);

	// wrapper
	this.wrapper = this.parent;
	this.$wrapper = $(this.wrapper);
	frappe.ui.make_app_page({
		parent: this.wrapper,
		single_column: this.meta.hide_toolbar
	});
	this.page = this.wrapper.page;
	this.layout_main = this.page.main.get(0);

	this.toolbar = new frappe.ui.form.Toolbar({
		frm: this,
		page: this.page
	});

	// print layout
	this.setup_print_layout();

	// 2 column layout
	this.setup_std_layout();

	// client script must be called after "setup" - there are no fields_dict attached to the frm otherwise
	this.script_manager = new frappe.ui.form.ScriptManager({
		frm: this
	});
	this.script_manager.setup();
	this.watch_model_updates();

	if(!this.meta.hide_toolbar) {
		this.footer = new frappe.ui.form.Footer({
			frm: this,
			parent: $('<div>').appendTo(this.page.main.parent())
		});
		$("body").attr("data-sidebar", 1);
	}
	this.setup_drag_drop();

	this.setup_done = true;
};

_f.Frm.prototype.setup_drag_drop = function() {
	var me = this;
	this.$wrapper.on('dragenter dragover', false)
		.on('drop', function(e) {
			var dataTransfer = e.originalEvent.dataTransfer;
			if (!(dataTransfer && dataTransfer.files && dataTransfer.files.length > 0)) {
				return;
			}

			e.stopPropagation();
			e.preventDefault();

			if(me.doc.__islocal) {
				frappe.msgprint(__("Please save before attaching."));
				throw "attach error";
			}

			if(me.attachments.max_reached()) {
				frappe.msgprint(__("Maximum Attachment Limit for this record reached."));
				throw "attach error";
			}

			frappe.upload.make({
				args: me.attachments.get_args(),
				files: dataTransfer.files,
				callback: function(attachment, r) {
					me.attachments.attachment_uploaded(attachment, r);
				}
			});
		});
};

_f.Frm.prototype.setup_print_layout = function() {
	var me = this;
	this.print_preview = new frappe.ui.form.PrintPreview({
		frm: this
	});

	// show edit button for print view
	this.page.wrapper.on('view-change', function() {
		me.toolbar.set_primary_action();
	});
};

_f.Frm.prototype.print_doc = function() {
	if(this.print_preview.wrapper.is(":visible")) {
		this.hide_print();
		return;
	}
	if(!frappe.model.can_print(this.doc.doctype, this)) {
		frappe.msgprint(__("You are not allowed to print this document"));
		return;
	}

	this.print_preview.refresh_print_options().trigger("change");
	this.page.set_view("print");
	this.print_preview.set_user_lang();
	this.print_preview.set_default_print_language();
	this.print_preview.preview();
};

_f.Frm.prototype.hide_print = function() {
	if(this.setup_done && this.page.current_view_name==="print") {
		this.page.set_view(this.page.previous_view_name==="print" ?
			"main" : (this.page.previous_view_name || "main"));
	}
};

_f.Frm.prototype.watch_model_updates = function() {
	// watch model updates
	var me = this;

	// on main doc
	frappe.model.on(me.doctype, "*", function(fieldname, value, doc) {
		// set input
		if(doc.name===me.docname) {
			if ((value==='' || value===null) && !doc[fieldname]) {
				// both the incoming and outgoing values are falsy
				// the texteditor, summernote, changes nulls to empty strings on render,
				// so ignore those changes
			} else {
				me.dirty();
			}
			me.fields_dict[fieldname]
				&& me.fields_dict[fieldname].refresh(fieldname);

			me.layout.refresh_dependency();
			let object = me.script_manager.trigger(fieldname, doc.doctype, doc.name);
			return object;
		}
	});

	// on table fields
	var table_fields = frappe.get_children("DocType", me.doctype, "fields", {fieldtype:"Table"});

	// using $.each to preserve df via closure
	$.each(table_fields, function(i, df) {
		frappe.model.on(df.options, "*", function(fieldname, value, doc) {
			if(doc.parent===me.docname && doc.parentfield===df.fieldname) {
				me.dirty();
				me.fields_dict[df.fieldname].grid.set_value(fieldname, value, doc);
				me.script_manager.trigger(fieldname, doc.doctype, doc.name);
			}
		});
	});
};

_f.Frm.prototype.setup_std_layout = function() {
	this.form_wrapper 	= $('<div></div>').appendTo(this.layout_main);
	this.body 			= $('<div></div>').appendTo(this.form_wrapper);

	// only tray
	this.meta.section_style='Simple'; // always simple!

	// layout
	this.layout = new frappe.ui.form.Layout({
		parent: this.body,
		doctype: this.doctype,
		frm: this,
		with_dashboard: true
	});
	this.layout.make();

	this.fields_dict = this.layout.fields_dict;
	this.fields = this.layout.fields_list;

	this.document_flow = new frappe.ui.form.DocumentFlow({
		frm: this
	});

	this.dashboard = new frappe.ui.form.Dashboard({
		frm: this,
	});

	// state
	this.states = new frappe.ui.form.States({
		frm: this
	});
};

// email the form
_f.Frm.prototype.email_doc = function(message) {
	new frappe.views.CommunicationComposer({
		doc: this.doc,
		frm: this,
		subject: __(this.meta.name) + ': ' + this.docname,
		recipients: this.doc.email || this.doc.email_id || this.doc.contact_email,
		attach_document_print: true,
		message: message,
		real_name: this.doc.real_name || this.doc.contact_display || this.doc.contact_name
	});
};

// rename the form
_f.Frm.prototype.rename_doc = function() {
	frappe.model.rename_doc(this.doctype, this.docname);
};

_f.Frm.prototype.share_doc = function() {
	this.shared.show();
};

// notify this form of renamed records
_f.Frm.prototype.rename_notify = function(dt, old, name) {
	// from form
	if(this.meta.istable)
		return;

	if(this.docname == old)
		this.docname = name;
	else
		return;

	// cleanup
	if(this && this.opendocs[old] && frappe.meta.docfield_copy[dt]) {
		// delete docfield copy
		frappe.meta.docfield_copy[dt][name] = frappe.meta.docfield_copy[dt][old];
		delete frappe.meta.docfield_copy[dt][old];
	}

	delete this.opendocs[old];
	this.opendocs[name] = true;

	if(this.meta.in_dialog || !this.in_form) {
		return;
	}

	frappe.re_route[window.location.hash] = '#Form/' + encodeURIComponent(this.doctype) + '/' + encodeURIComponent(name);
	frappe.set_route('Form', this.doctype, name);
};

// SETUP

_f.Frm.prototype.setup_meta = function() {
	this.meta = frappe.get_doc('DocType', this.doctype);
	this.perm = frappe.perm.get_perm(this.doctype); // for create
	if(this.meta.istable) {
		this.meta.in_dialog = 1;
	}
};

_f.Frm.prototype.refresh_header = function(is_a_different_doc) {
	// set title
	// main title
	if(!this.meta.in_dialog || this.in_form) {
		frappe.utils.set_title(this.meta.issingle ? this.doctype : this.docname);
	}

	// show / hide buttons
	if(this.toolbar) {
		if (is_a_different_doc) {
			this.toolbar.current_status = undefined;
		}

		this.toolbar.refresh();
	}

	this.document_flow.refresh();
	this.dashboard.refresh();

	if(this.meta.is_submittable
		&& this.perm[0] && this.perm[0].submit
		&& !this.is_dirty()
		&& !this.is_new()
		&& !frappe.model.has_workflow(this.doctype) // show only if no workflow
		&& this.doc.docstatus===0) {
		this.dashboard.add_comment(__('Submit this document to confirm'), 'orange', true);
	}

	this.clear_custom_buttons();

	this.show_web_link();
};

_f.Frm.prototype.show_web_link = function() {
	var doc = this.doc, me = this;
	if(!doc.__islocal && doc.__onload && doc.__onload.is_website_generator) {
		me.web_link && me.web_link.remove();
		if(doc.__onload.published) {
			me.add_web_link("/" + doc.route);
		}
	}
};

_f.Frm.prototype.add_web_link = function(path, label) {
	label = label || "See on Website";
	this.web_link = this.sidebar.add_user_action(__(label),
		function() {}).attr("href", path || this.doc.route).attr("target", "_blank");
};

_f.Frm.prototype.check_doc_perm = function() {
	// get perm
	var dt = this.parent_doctype?this.parent_doctype : this.doctype;
	this.perm = frappe.perm.get_perm(dt, this.doc);

	if(!this.perm[0].read) {
		return 0;
	}
	return 1;
};

_f.Frm.prototype.refresh = function(docname) {
	var is_a_different_doc = docname ? true : false;

	if(docname) {
		// record switch
		if(this.docname != docname && (!this.meta.in_dialog || this.in_form) && !this.meta.istable) {
			frappe.utils.scroll_to(0);
			this.hide_print();
		}
		// reset visible columns, since column headings can change in different docs
		this.grids.forEach(grid_obj => grid_obj.grid.visible_columns = null);
		frappe.ui.form.close_grid_form();
		this.docname = docname;
	}

	cur_frm = this;

	if(this.docname) { // document to show

		// set the doc
		this.doc = frappe.get_doc(this.doctype, this.docname);

		// check permissions
		if(!this.check_doc_perm()) {
			frappe.show_not_permitted(__(this.doctype) + " " + __(this.docname));
			return;
		}

		// read only (workflow)
		this.read_only = frappe.workflow.is_read_only(this.doctype, this.docname);
		if (this.read_only) this.set_read_only(true);

		// check if doctype is already open
		if (!this.opendocs[this.docname]) {
			this.check_doctype_conflict(this.docname);
		} else {
			if(this.doc && (!this.doc.__unsaved) && this.doc.__last_sync_on &&
				(new Date() - this.doc.__last_sync_on) > (this.refresh_if_stale_for * 1000)) {
				this.reload_doc();
				return;
			}
		}

		// do setup
		if(!this.setup_done) {
			this.setup();
		}

		// load the record for the first time, if not loaded (call 'onload')
		this.cscript.is_onload = false;
		if(!this.opendocs[this.docname]) {
			var me = this;
			this.cscript.is_onload = true;
			this.setnewdoc();
			$(document).trigger("form-load", [this]);
			$(this.page.wrapper).on('hide',  function() {
				$(document).trigger("form-unload", [me]);
			});
		} else {
			this.render_form(is_a_different_doc);
			if (this.doc.localname) {
				// trigger form-rename and remove .localname
				delete this.doc.localname;
				$(document).trigger("form-rename", [this]);
			}
		}

		// if print format is shown, refresh the format
		if(this.print_preview.wrapper.is(":visible")) {
			this.print_preview.preview();
		}

		if(is_a_different_doc) {
			if(this.show_print_first && this.doc.docstatus===1) {
				// show print view
				this.print_doc();
			}
		}

		// set status classes
		this.$wrapper.removeClass('validated-form')
			.toggleClass('editable-form', this.doc.docstatus===0)
			.toggleClass('submitted-form', this.doc.docstatus===1)
			.toggleClass('cancelled-form', this.doc.docstatus===2);

		this.show_if_needs_refresh();
	}
};

_f.Frm.prototype.show_if_needs_refresh = function() {
	if(this.doc.__needs_refresh) {
		if(this.doc.__unsaved) {
			this.dashboard.clear_headline();
			this.dashboard.set_headline_alert(__("This form has been modified after you have loaded it")
				+ '<a class="btn btn-xs btn-primary pull-right" onclick="cur_frm.reload_doc()">'
				+ __("Refresh") + '</a>', "alert-warning");
		} else {
			this.reload_doc();
		}
	}
};

_f.Frm.prototype.render_form = function(is_a_different_doc) {
	if(!this.meta.istable) {
		this.layout.doc = this.doc;
		this.layout.attach_doc_and_docfields();

		this.sidebar = new frappe.ui.form.Sidebar({
			frm: this,
			page: this.page
		});
		this.sidebar.make();

		// clear layout message
		this.layout.show_message();

		frappe.run_serially([
			// header must be refreshed before client methods
			// because add_custom_button
			() => this.refresh_header(is_a_different_doc),
			// trigger global trigger
			// to use this
			() => $(document).trigger('form-refresh', [this]),
			// fields
			() => this.refresh_fields(),
			// call trigger
			() => this.script_manager.trigger("refresh"),
			// call onload post render for callbacks to be fired
			() => {
				if(this.cscript.is_onload) {
					return this.script_manager.trigger("onload_post_render");
				}
			},
			() => this.dashboard.after_refresh()
		]);
		// focus on first input

		if(this.is_new()) {
			var first = this.form_wrapper.find('.form-layout input:first');
			if(!in_list(["Date", "Datetime"], first.attr("data-fieldtype"))) {
				first.focus();
			}
		}
	} else {
		this.refresh_header(is_a_different_doc);
	}

	this.$wrapper.trigger('render_complete');

	if(!this.hidden) {
		this.layout.show_empty_form_message();
	}

	this.scroll_to_element();
};

_f.Frm.prototype.refresh_field = function(fname) {
	if(this.fields_dict[fname] && this.fields_dict[fname].refresh) {
		this.fields_dict[fname].refresh();
		this.layout.refresh_dependency();
	}
};

_f.Frm.prototype.refresh_fields = function() {
	this.layout.refresh(this.doc);
	this.layout.primary_button = this.$wrapper.find(".btn-primary");

	// cleanup activities after refresh
	this.cleanup_refresh(this);
};


_f.Frm.prototype.cleanup_refresh = function() {
	var me = this;
	if(me.fields_dict['amended_from']) {
		if (me.doc.amended_from) {
			unhide_field('amended_from');
			if (me.fields_dict['amendment_date']) unhide_field('amendment_date');
		} else {
			hide_field('amended_from');
			if (me.fields_dict['amendment_date']) hide_field('amendment_date');
		}
	}

	if(me.fields_dict['trash_reason']) {
		if(me.doc.trash_reason && me.doc.docstatus == 2) {
			unhide_field('trash_reason');
		} else {
			hide_field('trash_reason');
		}
	}

	if(me.meta.autoname && me.meta.autoname.substr(0,6)=='field:' && !me.doc.__islocal) {
		var fn = me.meta.autoname.substr(6);

		if (me.doc[fn]) {
			me.toggle_display(fn, false);
		}
	}

	if(me.meta.autoname=="naming_series:" && !me.doc.__islocal) {
		me.toggle_display("naming_series", false);
	}
};

_f.Frm.prototype.setnewdoc = function() {
	// moved this call to refresh function
	// this.check_doctype_conflict(docname);
	var me = this;

	// hide any open grid
	this.script_manager.trigger("before_load", this.doctype, this.docname)
		.then(() => {
			me.script_manager.trigger("onload");
			me.opendocs[me.docname] = true;
			me.render_form();

			frappe.after_ajax(function() {
				me.trigger_link_fields();
			});

			frappe.breadcrumbs.add(me.meta.module, me.doctype);
		});

	// update seen
	if(this.meta.track_seen) {
		$('.list-id[data-name="'+ me.docname +'"]').addClass('seen');
	}
};

_f.Frm.prototype.trigger_link_fields = function() {
	// trigger link fields which have default values set
	if (this.is_new() && this.doc.__run_link_triggers) {
		$.each(this.fields_dict, function(fieldname, field) {
			if (in_list(['Link', 'Dynamic Link'], field.df.fieldtype) && this.doc[fieldname]) {
				// triggers add fetch, sets value in model and runs triggers
				field.set_value(this.doc[fieldname]);
			}
		});

		delete this.doc.__run_link_triggers;
	}
};

_f.Frm.prototype.runscript = function(scriptname, callingfield, onrefresh) {
	var me = this;
	if(this.docname) {
		// send to run
		if(callingfield)
			$(callingfield.input).set_working();

		frappe.call({
			method: "runserverobj",
			args: {'docs':this.doc, 'method':scriptname },
			btn: callingfield.$input,
			callback: function(r) {
				if(!r.exc) {
					if(onrefresh) {
						onrefresh(r);
					}

					me.refresh_fields();
				}
			}
		});
	}
};

_f.Frm.prototype.copy_doc = function(onload, from_amend) {
	this.validate_form_action("Create");
	var newdoc = frappe.model.copy_doc(this.doc, from_amend);

	newdoc.idx = null;
	newdoc.__run_link_triggers = false;
	if(onload) {
		onload(newdoc);
	}
	frappe.set_route('Form', newdoc.doctype, newdoc.name);
};

_f.Frm.prototype.reload_doc = function() {
	this.check_doctype_conflict(this.docname);

	var me = this;

	if(!me.doc.__islocal) {
		frappe.model.remove_from_locals(me.doctype, me.docname);
		frappe.model.with_doc(me.doctype, me.docname, function() {
			me.refresh();
		});
	}
};

frappe.validated = 0;
// Proxy for frappe.validated
Object.defineProperty(window, 'validated', {
	get: function() {
		console.warn('Please use `frappe.validated` instead of `validated`. It will be deprecated soon.');
		return frappe.validated;
	},
	set: function(value) {
		console.warn('Please use `frappe.validated` instead of `validated`. It will be deprecated soon.');
		frappe.validated = value;
		return frappe.validated;
	}
});

_f.Frm.prototype.save = function(save_action, callback, btn, on_error) {
	let me = this;
	return new Promise((resolve, reject) => {
		btn && $(btn).prop("disabled", true);
		$(document.activeElement).blur();

		frappe.ui.form.close_grid_form();
		// let any pending js process finish
		setTimeout(function() {
			me._save(save_action, callback, btn, on_error, resolve, reject);
		}, 100);
	}).then(() => {
		me.show_success_action();
	}).catch((e) => {
		console.error(e);
	});
};

_f.Frm.prototype._save = function(save_action, callback, btn, on_error, resolve, reject) {
	var me = this;
	if(!save_action) save_action = "Save";
	this.validate_form_action(save_action, resolve);

	if((!this.meta.in_dialog || this.in_form) && !this.meta.istable) {
		frappe.utils.scroll_to(0);
	}
	var after_save = function(r) {
		if (!r.exc) {
			if (["Save", "Update", "Amend"].indexOf(save_action) !== -1) {
				frappe.utils.play_sound("click");
			}

			me.script_manager.trigger("after_save");
			// submit comment if entered
			if (me.timeline) {
				me.timeline.comment_area.submit();
			}
			me.refresh();
		} else {
			if (on_error) {
				on_error();
				reject();
			}
		}

		callback && callback(r);
		resolve();
	};

	var fail = () => {
		btn && $(btn).prop("disabled", false);
		if(on_error) {
			on_error();
			reject();
		}
	};

	if(save_action != "Update") {
		// validate
		frappe.validated = true;
		frappe.run_serially([
			() => this.script_manager.trigger("validate"),
			() => this.script_manager.trigger("before_save"),
			() => {
				if(!frappe.validated) {
					fail();
					return;
				}

				frappe.ui.form.save(me, save_action, after_save, btn);
			}
		]).catch(fail);
	} else {
		frappe.ui.form.save(me, save_action, after_save, btn);
	}
};


_f.Frm.prototype.savesubmit = function(btn, callback, on_error) {
	var me = this;

	let handle_fail = () => {
		$(btn).prop('disabled', false);
		if (on_error) {
			on_error();
		}
	};

	return new Promise(resolve => {
		this.validate_form_action("Submit");
		frappe.confirm(__("Permanently Submit {0}?", [this.docname]), function() {
			frappe.validated = true;
			me.script_manager.trigger("before_submit").then(function() {
				if(!frappe.validated) {
					handle_fail();
					return;
				}

				me.save('Submit', function(r) {
					if(r.exc) {
						handle_fail();
					} else {
						frappe.utils.play_sound("submit");
						callback && callback();
						me.script_manager.trigger("on_submit")
							.then(() => resolve(me));
					}
				}, btn, () => handle_fail(), resolve);
			});
		}, () => handle_fail() );
	});
};

_f.Frm.prototype.savecancel = function(btn, callback, on_error) {
	var me = this;

	let handle_fail = () => {
		$(btn).prop('disabled', false);
		if (on_error) {
			on_error();
		}
	};

	this.validate_form_action('Cancel');
	frappe.confirm(__("Permanently Cancel {0}?", [this.docname]), function() {
		frappe.validated = true;
		me.script_manager.trigger("before_cancel").then(function() {
			if(!frappe.validated) {
				handle_fail();
				return;
			}

			var after_cancel = function(r) {
				if(r.exc) {
					handle_fail();
				} else {
					frappe.utils.play_sound("cancel");
					me.refresh();
					callback && callback();
					me.script_manager.trigger("after_cancel");
				}
			};
			frappe.ui.form.save(me, "cancel", after_cancel, btn);
		});
	}, () => handle_fail());
};

// delete the record
_f.Frm.prototype.savetrash = function() {
	this.validate_form_action("Delete");
	frappe.model.delete_doc(this.doctype, this.docname, function() {
		window.history.back();
	});
};

_f.Frm.prototype.amend_doc = function() {
	if(!this.fields_dict['amended_from']) {
		alert('"amended_from" field must be present to do an amendment.');
		return;
	}
	this.validate_form_action("Amend");
	var me = this;
	var fn = function(newdoc) {
		newdoc.amended_from = me.docname;
		if(me.fields_dict && me.fields_dict['amendment_date'])
			newdoc.amendment_date = frappe.datetime.obj_to_str(new Date());
	};
	this.copy_doc(fn, 1);
	frappe.utils.play_sound("click");
};

_f.Frm.prototype.disable_save = function() {
	// IMPORTANT: this function should be called in refresh event
	this.save_disabled = true;
	this.toolbar.current_status = null;
	this.page.clear_primary_action();
};

_f.Frm.prototype.enable_save = function() {
	this.save_disabled = false;
	this.toolbar.set_primary_action();
};

_f.Frm.prototype.save_or_update = function() {
	if(this.save_disabled) return;

	if(this.doc.docstatus===0) {
		this.save();
	} else if(this.doc.docstatus===1 && this.doc.__unsaved) {
		this.save("Update");
	}
};

_f.Frm.prototype.dirty = function() {
	this.doc.__unsaved = 1;
	this.$wrapper.trigger('dirty');
};

_f.Frm.prototype.get_docinfo = function() {
	return frappe.model.docinfo[this.doctype][this.docname];
};

_f.Frm.prototype.is_dirty = function() {
	return this.doc.__unsaved;
};

_f.Frm.prototype.is_new = function() {
	return this.doc.__islocal;
};


_f.Frm.prototype.reload_docinfo = function(callback) {
	var me = this;
	frappe.call({
		method: "frappe.desk.form.load.get_docinfo",
		args: {
			doctype: me.doctype,
			name: me.doc.name
		},
		callback: function(r) {
			// docinfo will be synced
			if(callback) callback(r.docinfo);
			me.timeline.refresh();
			me.assign_to.refresh();
			me.attachments.refresh();
		}
	});
};


_f.Frm.prototype.get_perm = function(permlevel, access_type) {
	return this.perm[permlevel] ? this.perm[permlevel][access_type] : null;
};


_f.Frm.prototype.set_intro = function(txt) {
	this.dashboard.set_headline_alert(txt);
};

_f.Frm.prototype.set_footnote = function(txt) {
	this.footnote_area = frappe.utils.set_footnote(this.footnote_area, this.body, txt);
};


_f.Frm.prototype.add_custom_button = function(label, fn, group) {
	// temp! old parameter used to be icon
	if(group && group.indexOf("fa fa-")!==-1) group = null;
	var btn = this.page.add_inner_button(label, fn, group);
	if(btn) {
		this.custom_buttons[label] = btn;
	}
	return btn;
};

//Remove all custom buttons
_f.Frm.prototype.clear_custom_buttons = function() {
	this.page.clear_inner_toolbar();
	this.page.clear_user_actions();
	this.custom_buttons = {};
};

//Remove specific custom button by button Label
_f.Frm.prototype.remove_custom_button = function(label, group) {
	this.page.remove_inner_button(label, group);
};

_f.Frm.prototype.add_fetch = function(link_field, src_field, tar_field) {
	if(!this.fetch_dict[link_field]) {
		this.fetch_dict[link_field] = {'columns':[], 'fields':[]};
	}
	this.fetch_dict[link_field].columns.push(src_field);
	this.fetch_dict[link_field].fields.push(tar_field);
};

_f.Frm.prototype.set_print_heading = function(txt) {
	this.pformat[this.docname] = txt;
};

_f.Frm.prototype.action_perm_type_map = {
	"Create": "create",
	"Save": "write",
	"Submit": "submit",
	"Update": "submit",
	"Cancel": "cancel",
	"Amend": "amend",
	"Delete": "delete"
};

_f.Frm.prototype.validate_form_action = function(action, resolve) {
	var perm_to_check = this.action_perm_type_map[action];
	var allowed_for_workflow = false;
	var perms = frappe.perm.get_perm(this.doc.doctype)[0];

	// Allow submit, write, cancel and create permissions for read only documents that are assigned by
	// workflows if the user already have those permissions. This is to allow for users to
	// continue through the workflow states and to allow execution of functions like Duplicate.
	if ((frappe.workflow.is_read_only(this.doctype, this.docname) && (perms["write"] ||
		perms["create"] || perms["submit"] || perms["cancel"])) || !frappe.workflow.is_read_only(this.doctype, this.docname)) {
		allowed_for_workflow = true;
	}

	if (!this.perm[0][perm_to_check] && !allowed_for_workflow) {
		if(resolve) {
			// re-enable buttons
			resolve();
		}
		frappe.throw (__("No permission to '{0}' {1}", [__(action), __(this.doc.doctype)]));
	}
};

_f.Frm.prototype.has_perm = function(ptype) {
	return frappe.perm.has_perm(this.doctype, 0, ptype, this.doc);
};

_f.Frm.prototype.scroll_to_element = function() {
	if (frappe.route_options && frappe.route_options.scroll_to) {
		var scroll_to = frappe.route_options.scroll_to;
		delete frappe.route_options.scroll_to;

		var selector = [];
		for (var key in scroll_to) {
			var value = scroll_to[key];
			selector.push(repl('[data-%(key)s="%(value)s"]', {key: key, value: value}));
		}

		selector = $(selector.join(" "));
		if (selector.length) {
			frappe.utils.scroll_to(selector);
		}
	}
};

_f.Frm.prototype.show_success_action = function() {
	const route = frappe.get_route();
	if (route[0] !== 'Form') return;
	if (this.meta.is_submittable && this.doc.docstatus !== 1) return;

	const success_action = new frappe.ui.form.SuccessAction(this);
	success_action.show();
};

_f.Frm.prototype.is_first_creation = function() {
	let { modified, creation } = this.doc;

	// strip out milliseconds
	modified = modified.split('.')[0];
	creation = creation.split('.')[0];

	return modified === creation;
};
