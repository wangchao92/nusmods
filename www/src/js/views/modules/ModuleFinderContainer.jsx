// @flow
import type { ContextRouter } from 'react-router-dom';

import React, { Component } from 'react';
import Helmet from 'react-helmet';
import { withRouter } from 'react-router-dom';
import { connect } from 'react-redux';
import axios from 'axios';
import update from 'immutability-helper';
import qs from 'query-string';
import Raven from 'raven-js';
import { clone, each, mapValues, values } from 'lodash';

import type { Module } from 'types/modules';
import type { PageRange, PageRangeDiff, FilterGroupId } from 'types/views';
import type { State as StoreState } from 'reducers';

import { Semesters } from 'types/modules';
import ModuleFinderList from 'views/modules/ModuleFinderList';
import ModuleSearchBox from 'views/modules/ModuleSearchBox';
import ChecklistFilters from 'views/components/filters/ChecklistFilters';
import TimeslotFilters from 'views/components/filters/TimeslotFilters';
import DropdownListFilters from 'views/components/filters/DropdownListFilters';
import ErrorPage from 'views/errors/ErrorPage';
import LoadingSpinner from 'views/components/LoadingSpinner';
import SideMenu, { OPEN_MENU_LABEL } from 'views/components/SideMenu';
import { Filter } from 'views/components/icons';

import {
  defaultGroups,
  updateGroups,
  serializeGroups,
  invertFacultyDepartments,
  DEPARTMENT,
  EXAMS,
  FACULTY,
  LEVELS,
  LECTURE_TIMESLOTS,
  MODULE_CREDITS,
  SEMESTER,
  TUTORIAL_TIMESLOTS,
} from 'utils/moduleFilters';
import { createSearchFilter, sortModules } from 'utils/moduleSearch';
import config from 'config';
import nusmods from 'apis/nusmods';
import { resetModuleFinder } from 'actions/moduleFinder';
import FilterGroup from 'utils/filters/FilterGroup';
import HistoryDebouncer from 'utils/HistoryDebouncer';
import { defer } from 'utils/react';
import { breakpointUp, queryMatch } from 'utils/css';
import styles from './ModuleFinderContainer.scss';

type Props = {
  searchTerm: string,
  resetModuleFinder: () => any,
  ...ContextRouter,
};

type State = {
  loading: boolean,
  page: PageRange,
  modules: Module[],
  filterGroups: { [FilterGroupId]: FilterGroup<any> },
  isMenuOpen: boolean,
  error?: any,
};

// Threshold to enable instant search based on the amount of time it takes to
// run the filters on initial render. This is only an estimate since only
// ~50% of the time is spent on filters (the other 50% on rendering), and we can
// only benchmark filtering, not rendering, so we err on using a lower threshold
const INSTANT_SEARCH_THRESHOLD = 300;

const pageHead = (
  <Helmet>
    <title>Modules - {config.brandName}</title>
  </Helmet>
);

export function mergePageRange(prev: PageRange, diff: PageRangeDiff): PageRange {
  const next = clone(prev);

  // Current page is SET from the diff object
  if (diff.current != null) {
    next.current = diff.current;
  }

  // Start and pages are ADDED from the diff object
  ['start', 'loaded'].forEach((key) => {
    if (diff[key] != null) {
      next[key] += diff[key];
    }
  });

  return next;
}

export class ModuleFinderContainerComponent extends Component<Props, State> {
  history: HistoryDebouncer;
  unlisten: () => void;

  constructor(props: Props) {
    super(props);

    // Set up history debouncer and history listener
    this.history = new HistoryDebouncer(props.history);
    this.unlisten = props.history.listen((location) => this.onQueryStringChange(location.search));

    this.state = {
      filterGroups: {},
      page: this.startingPageRange(),
      loading: true,
      modules: [],
      isMenuOpen: false,
    };
  }

  componentDidMount() {
    // Load module data
    const modulesRequest = axios.get(nusmods.modulesUrl()).then(({ data }) => data);

    // Load faculty-department mapping
    const makeFacultyRequest = (semester) =>
      axios
        .get(nusmods.facultyDepartmentsUrl(semester))
        .then(({ data }) => invertFacultyDepartments(data));

    const facultiesRequest = Promise.all(Semesters.map(makeFacultyRequest))
      // Then merge all of the mappings together
      .then((mappings) => Object.assign({}, ...mappings));

    // Finally initialize everything
    Promise.all([modulesRequest, facultiesRequest])
      .then(([modules, faculties]) => {
        const params = qs.parse(this.props.location.search);
        const filterGroups = defaultGroups(faculties, this.props.location.search);

        // Benchmark the amount of time taken to run the filters to determine if we can
        // use instant search
        const start = performance.now();
        each(filterGroups, (group) => group.initFilters(modules));
        const time = performance.now() - start;

        if ('instant' in params) {
          // Manual override - use 'instant=1' to force instant search, and
          // 'instant=0' to force non-instant search
          this.useInstantSearch = params.instant === '1';
        } else {
          // By default, only turn on instant search for desktop and if the
          // benchmark earlier is fast enough
          this.useInstantSearch =
            queryMatch(breakpointUp('sm')).matches && time < INSTANT_SEARCH_THRESHOLD;
        }

        console.info(`${time}ms taken to init filters`); // eslint-disable-line
        console.info(this.useInstantSearch ? 'Instant search on' : 'Instant search off'); // eslint-disable-line

        this.setState({
          filterGroups,
          modules,
          loading: false,
        });
      })
      .catch((error) => {
        Raven.captureException(error);
        this.setState({ error });
      });
  }

  componentWillReceiveProps(nextProps: Props) {
    if (this.props.searchTerm !== nextProps.searchTerm) {
      this.onSearch(nextProps.searchTerm);
    }
  }

  componentWillUnmount() {
    this.props.resetModuleFinder();
    this.unlisten();
  }

  // Event handlers
  onQueryStringChange(query: string) {
    const { filterGroups } = this.state;

    // Trim the starting '?' character
    if (query.replace(/^\?/, '') !== serializeGroups(filterGroups)) {
      this.setState({
        filterGroups: updateGroups(filterGroups, query),
      });
    }
  }

  onFilterChange = (newGroup: FilterGroup<*>, resetScroll: boolean = true) => {
    this.setState(
      (state) =>
        update(state, {
          // Update filter group with its new state
          filterGroups: { [newGroup.id]: { $set: newGroup } },
          // Reset back to the first page
          page: { $merge: { start: 0, current: 0 } },
        }),
      () => {
        // Update query string after state is updated
        this.history.push({
          ...this.props.history.location,
          search: serializeGroups(this.state.filterGroups),
        });

        // Scroll back to the top
        if (resetScroll) window.scrollTo(0, 0);
      },
    );
  };

  onPageChange = (diff: PageRangeDiff) => {
    this.setState(
      (prevState) => ({
        page: mergePageRange(prevState.page, diff),
      }),
      this.updatePageHash,
    );
  };

  onSearch(searchTerm: string) {
    const filter = createSearchFilter(searchTerm).initFilters(this.state.modules);

    defer(() => {
      this.onFilterChange(filter, false);
      this.toggleMenu(false);
    });
  }

  useInstantSearch = false;

  updatePageHash = () => {
    // Update the location hash so that users can share the URL and go back to the
    // correct page when the going back in history
    const { current } = this.state.page;
    this.history.push({
      ...this.props.history.location,
      hash: current ? `page=${current}` : '',
    });
  };

  toggleMenu = (isMenuOpen: boolean) => this.setState({ isMenuOpen });

  filterGroups(): FilterGroup<any>[] {
    return values(this.state.filterGroups);
  }

  startingPageRange(): PageRange {
    const hashMatch = this.props.location.hash.match(/page=(\d+)/);
    const start = hashMatch ? parseInt(hashMatch[1], 10) : 0;

    return {
      start,
      current: start,
      loaded: 1,
    };
  }

  render() {
    const { filterGroups: groups, isMenuOpen, modules, loading, page, error } = this.state;

    if (error) {
      return <ErrorPage error="cannot load modules info" eventId={Raven.lastEventId()} />;
    }

    if (loading) {
      return (
        <div>
          {pageHead}
          <LoadingSpinner />
        </div>
      );
    }

    // Set up filter groups and sort by relevance if search is active
    let filteredModules = FilterGroup.apply(modules, this.filterGroups());
    if (this.props.searchTerm) {
      filteredModules = sortModules(this.props.searchTerm, filteredModules);
    }

    const filterProps = {
      groups: values(groups),
      onFilterChange: this.onFilterChange,
    };

    return (
      <div className="modules-page-container page-container">
        {pageHead}

        <div className="row">
          <div className="col">
            <h1 className="sr-only">Module Finder</h1>

            <ModuleSearchBox useInstantSearch={this.useInstantSearch} />

            <ModuleFinderList
              modules={filteredModules}
              page={page}
              onPageChange={this.onPageChange}
            />
          </div>

          <div className="col-md-4 col-lg-3">
            <SideMenu
              isOpen={isMenuOpen}
              toggleMenu={this.toggleMenu}
              openIcon={<Filter aria-label={OPEN_MENU_LABEL} />}
            >
              <div className={styles.moduleFilters}>
                <header className={styles.filterHeader}>
                  <h3>Refine by</h3>
                  {this.filterGroups().some((group) => group.isActive()) && (
                    <button
                      className="btn btn-link btn-sm"
                      type="button"
                      onClick={() =>
                        this.setState({
                          filterGroups: mapValues(groups, (group: FilterGroup<*>) => group.reset()),
                        })
                      }
                    >
                      Clear Filters
                    </button>
                  )}
                </header>

                <ChecklistFilters group={groups[SEMESTER]} {...filterProps} />

                <ChecklistFilters group={groups[LEVELS]} {...filterProps} />

                <ChecklistFilters group={groups[EXAMS]} {...filterProps} />

                <ChecklistFilters group={groups[MODULE_CREDITS]} {...filterProps} />

                <DropdownListFilters group={groups[FACULTY]} {...filterProps} />

                <DropdownListFilters group={groups[DEPARTMENT]} {...filterProps} />

                <TimeslotFilters group={groups[LECTURE_TIMESLOTS]} {...filterProps} />

                <TimeslotFilters group={groups[TUTORIAL_TIMESLOTS]} {...filterProps} />
              </div>
            </SideMenu>
          </div>
        </div>
      </div>
    );
  }
}

const mapStateToProps = (state: StoreState) => ({
  searchTerm: state.moduleFinder.search.term,
});

// Explicitly naming the components to make HMR work
const ModuleFinderContainerWithRouter = withRouter(ModuleFinderContainerComponent);
const ModuleFinderContainer = connect(mapStateToProps, { resetModuleFinder })(
  ModuleFinderContainerWithRouter,
);
export default ModuleFinderContainer;
